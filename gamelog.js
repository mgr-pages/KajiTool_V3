/* =====================================================================
   対局の記録(利用者の結果と各手順を集め、どこがダメだったかを後で分析するため)。
   ・打ち始め(最初の「使った」)から、推奨手・打った手・入れた値・手直し・点灯の選択・取り消しを記録する。
   ・打ち始めた後に「最初から」や素材の切り替えをすると、結果(大成功/成功/失敗/途中でやめた)を
     選ばないと先へ進めない(ui.js の askOutcome)。選ぶと記録を端末に貯めて、すぐにリセットする。
   ・送り先は Google スプレッドシートの Apps Script(tools/log-collector.gs)。GLOG_ENDPOINT に
     公開した URL を入れる。空なら送らずに端末に貯めておき、URL が入った版で送る。
   ・名前やログインは使わない。端末ごとにランダムな番号と、ブラウザ・OS の大まかな分類(glogEnv)を付ける。
   ・結果を選んだら端末に貯めてすぐリセットし、送信は裏で行う。送れなかった記録は端末に残し、
     次に開いた時や次の対局の終わりに送り直す。
   ===================================================================== */
const GLOG_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxkB5vfT1uM7wooVpSrsqCu8zMseSrtQf8k08Qcqp0vCGzJd5sFqCnjIABHWMOMkvPbXg/exec';            // Apps Script を「ウェブアプリ」として公開した URL(…/exec)
const GLOG_CUR = 'kajiAdvisorLogCurV1', GLOG_QUEUE = 'kajiAdvisorLogQueueV1', GLOG_DEV = 'kajiAdvisorDeviceV1';
const GLOG_MAXQ = 50;                // 貯めておく記録の上限(古いものから捨てる)

// 端末のブラウザと OS を大まかに分類する(バージョンの番号などは送らない)。
// iPad の Safari はパソコンの Mac と同じ名乗りをするので、画面に触れる Mac は iPadOS とみなす。
function glogEnv(ua, touch){
  ua = ua || ''; touch = touch || 0;
  let os = 'その他';
  if(/iPhone|iPod/.test(ua)) os = 'iOS';
  else if(/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) os = 'iPadOS';
  else if(/Android/.test(ua)) os = 'Android';
  else if(/CrOS/.test(ua)) os = 'ChromeOS';
  else if(/Windows/.test(ua)) os = 'Windows';
  else if(/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if(/Linux/.test(ua)) os = 'Linux';
  let browser = 'その他';
  if(/ Line\//.test(ua)) browser = 'LINE';
  else if(/EdgA?\/|EdgiOS\/|Edg\//.test(ua)) browser = 'Edge';
  else if(/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if(/OPR\/|OPiOS\//.test(ua)) browser = 'Opera';
  else if(/FxiOS\/|Firefox\//.test(ua)) browser = 'Firefox';
  else if(/CriOS\/|Chrome\//.test(ua)) browser = 'Chrome';
  else if(/Safari\//.test(ua)) browser = 'Safari';
  return { browser, os };
}

const GameLog = (function(){
  let cur = null;
  const rd = k => { try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } };
  const wr = (k, v) => { try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} };
  function rid(){
    const a = new Uint8Array(8);
    (self.crypto || window.crypto).getRandomValues(a);
    return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function device(){
    let d = null; try{ d = localStorage.getItem(GLOG_DEV); }catch(e){}
    if(!d){ d = rid(); try{ localStorage.setItem(GLOG_DEV, d); }catch(e){} }
    return d;
  }
  function snap(){
    return { temp: G.temp, focus: G.focus, masses: G.masses.filter(m => !m.off).map(m => m.current) };
  }
  // 打ち始めた時に作る。盤面・設定は最初に一度だけ控える
  function ensure(){
    if(cur) return cur;
    cur = { id: rid(), device: device(), started: new Date().toISOString(),
            version: (document.getElementById('v-ver') || {}).textContent || '',
            preset: G.preset, trait: G.trait, level: G.level, hammer: G.hammerId, star: G.star,
            threshold: SUCCESS_THRESHOLD,
            env: (typeof navigator !== 'undefined') ? glogEnv(navigator.userAgent, navigator.maxTouchPoints) : null,
            zones: G.masses.map((m, i) => m.off ? null : [i + 1, m.zoneLow, m.zoneHigh]).filter(Boolean),
            steps: [] };
    return cur;
  }
  function ev(type, data){
    if(!cur && type !== 'exec') return;      // 打ち始める前の操作は記録しない
    ensure().steps.push(Object.assign({ t: type, at: snap() }, data || {}));
    wr(GLOG_CUR, cur);
  }
  function active(){ return !!cur; }
  async function send(rec){
    if(!GLOG_ENDPOINT) return false;
    try{
      // 応答は読めない(no-cors)ので、通信が通れば送れたものとする。
      // keepalive(画面を閉じても送り切る)はブラウザの上限が 64KB なので、長い記録には付けない
      const body = JSON.stringify(rec);
      await fetch(GLOG_ENDPOINT, { method: 'POST', mode: 'no-cors', keepalive: body.length < 60000,
                                   headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
      return true;
    }catch(e){ return false; }
  }
  // 貯めた記録を送る。送っている間に呼ばれたら、今の送信が終わった後にもう一度回す(同じ記録を2回送らない)。
  // 送っている間に貯まった記録を消さないよう、送れた記録だけを、その時の貯まりから番号で取り除く。
  let flushing = null, again = false;
  function flush(){
    if(flushing){ again = true; return flushing; }
    flushing = (async () => {
      do {
        again = false;
        const q = rd(GLOG_QUEUE) || [];
        if(!q.length || !GLOG_ENDPOINT) break;
        const sent = new Set();
        for(const r of q) if(await send(r)) sent.add(r.id);
        if(sent.size) wr(GLOG_QUEUE, (rd(GLOG_QUEUE) || []).filter(r => !sent.has(r.id)));
      } while(again);
    })().finally(() => { flushing = null; });
    return flushing;
  }
  // 結果を付けて記録を閉じ、端末に貯める。送信は裏で行い、待たない
  // (送り先の応答には数秒かかることがあり、待つとリセットまで画面が止まって見えるため)。
  function finish(outcome){
    if(!cur) return;
    const rec = Object.assign(cur, { outcome, finished: new Date().toISOString(), final: snap(),
                                     reached: G.masses.every(m => m.off || m.current >= m.zoneLow) });
    cur = null; wr(GLOG_CUR, null);
    const q = (rd(GLOG_QUEUE) || []).concat([rec]).slice(-GLOG_MAXQ);
    wr(GLOG_QUEUE, q);
    flush();
  }
  function restore(){ cur = rd(GLOG_CUR) || null; flush(); }
  return { ev, active, finish, restore, flush };
})();
