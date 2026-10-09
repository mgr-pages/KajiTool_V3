/* =====================================================================
   鍛冶アドバイザーの対局の記録を受け取る Google Apps Script。
   使い方(docs/記録の集め方.md に手順):
     1. Google スプレッドシートを新しく作り、[拡張機能] → [Apps Script] を開く
     2. このファイルの中身を貼り付けて保存する
        (スプレッドシートのメニューから作らなかった時は、SPREADSHEET_ID に URL の /d/ と /edit の間を入れる)
     3. 関数「testPost」を選んで[実行]し、「記録」シートに試験の行が1行入ることを確かめる(確かめたら消してよい)
     4. [デプロイ] → [新しいデプロイ] → 種類「ウェブアプリ」
        実行するユーザー: 自分 / アクセスできるユーザー: 全員
     5. 表示された URL(…/exec)を gamelog.js の GLOG_ENDPOINT に入れる
   1局ごとに「記録」シートへ1行を足す。手順の細かい中身は最後の列に JSON で入れる。
   doPost はアプリから送られた時に動く。エディタから doPost を直接実行しても、送られた中身が無いので何も書かない(ログに知らせを出す)。
   名前が _ で終わる関数は内部用(エディタの[実行]の一覧に出ない)。エディタから実行するのは testPost と updateCritSheet。
   会心率の集計(下の「会心率の集計」):
     ・スプレッドシートのメニュー [鍛冶アドバイザー] → [会心の集計を更新] で「会心の集計」シートを書き直す。
     ・同じ URL を GET で開くと、集計の数字だけを JSON で返す(端末の番号・手順などは返さない)。
       tools/crit-report.js で読んで、点灯マスなどの会心率の上乗せを推定する。
   このファイルを書き換えたら、[デプロイ] → [デプロイを管理] → 鉛筆 → バージョン「新バージョン」で出し直す(URL は同じ)。
   ===================================================================== */
const SPREADSHEET_ID = '';           // 空ならスクリプトを作ったスプレッドシートに書く
const SHEET = '記録';
const HEAD = ['受け取った日時', '記録の番号', '端末の番号(匿名)', '版', '素材', '地金特性', '職人Lv',
              'ハンマー', 'できのよさ', '許容誤差', '結果', '全マス到達', '残り集中力', '最後の温度',
              '最後の値(使うマス)', '手数(打った回数)', '取り消し', '始めた日時', '終えた日時', '手順(JSON)',
              'ブラウザ', 'OS'];

function doPost(e){
  // エディタの[実行]で doPost を選んで押すと、送られた中身(e)が無い。止まらずに、試す時は testPost を使うよう知らせる
  if(!e || !e.postData || !e.postData.contents){
    console.log('doPost はアプリから送られた時に動きます。エディタから試す時は testPost を実行してください。');
    return ContentService.createTextOutput('no data');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    const d = JSON.parse(e.postData.contents);
    const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(SHEET);
    if(!sh){ sh = ss.insertSheet(SHEET); sh.appendRow(HEAD); sh.setFrozenRows(1); }
    // 列を足した版に入れ替えた時は、見出しの行も足りない分を書き直す(これまでの行の並びは変えない)
    else if(sh.getLastColumn() < HEAD.length) sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);
    const steps = Array.isArray(d.steps) ? d.steps : [];
    const fin = d.final || {};
    sh.appendRow([new Date(), d.id, d.device, d.version, d.preset, d.trait, d.level, d.hammer, d.star,
                  d.threshold, d.outcome, d.reached, fin.focus, fin.temp, (fin.masses || []).join(' / '),
                  steps.filter(s => s.t === 'exec').length, steps.filter(s => s.t === 'undo').length,
                  d.started, d.finished, JSON.stringify({ zones: d.zones, steps }),
                  (d.env || {}).browser || '', (d.env || {}).os || '']);
    return ContentService.createTextOutput('ok');
  } finally {
    lock.releaseLock();
  }
}

// エディタから実行する試験。アプリから届いたのと同じ形の記録を1行書く(結果の欄は「試験」)
function testPost(){
  const rec = { id: 'test', device: 'test', version: 'test', preset: 'orb', trait: 'modori', level: 80,
                hammer: 'light', star: 3, threshold: 7, outcome: '試験', reached: false,
                final: { focus: 0, temp: 1000, masses: [0, 0, 0, 0, 0, 0] }, steps: [],
                started: new Date().toISOString(), finished: new Date().toISOString(), zones: [] };
  doPost({ postData: { contents: JSON.stringify(rec) } });
}

/* ===================== 会心率の集計 =====================
   エンジンの会心率の式(engine.js の computeCritRate)のうち、確かめられていない上乗せ
   (威力会心率上昇の点灯マス +400%(利用者の情報)、ねらい打ち +600%、集中力変化の会心ターン +400%)を、
   実際の対局の記録で確かめるための集計。
   1回の打撃ごとに「装備(ハンマー・できのよさ・職人Lv) × 地金特性 × 状況(点灯マス / 会心ターン / ふつう) × 技(ねらい系 / それ以外)」に
   分けて、叩いた回数・会心の回数・基礎の会心率の合計(上乗せの無い会心率)・エンジンの見込みの会心率の合計を数える。
   装備で分けるのは、ハンマーとできのよさで基礎の会心率が変わるため。混ぜると、ずれがハンマーの会心率の値から来たのか、
   上乗せから来たのかを見分けられない(利用者の指摘。光★2 の記録が混ざっていた)。
   基礎の会心率の合計で会心の回数を割ると、基礎に対する倍率(実測)になる。
   数えない打撃: 開始直後の1手(特性が乗らない)、必殺の効果中(必ず会心)、みだれ打ち(どのマスに当たったか分からない)、
   まとめて実行して同じマスを2回以上叩いた打撃(どちらで会心が出たか分からない)、戻りで減った後の値、取り消した手。
   記録の形:
     ・新しい版のアプリ: 入れた値(val)に、叩いた技(sk)・叩いた時の温度(hitTemp)・点灯マスか(lit)・
       見込みの会心率(cr)・会心でも会心でなくても出る値か(both)が付く。分けられない打撃には amb が付く。
     ・古い版: 打った手(exec)の手順と点灯マス(lit)から、各マスを叩いた技・温度・点灯を組み立て直す。 */
const CRIT_SHEET = '会心の集計';
const CRIT_AIM = ['ねらい打ち', '上下ねらい打ち', '弱ねらい打ち'];
const CRIT_SKIP = ['火力上げ', '冷やし込み', 'みだれ打ち', 'ヘパイトスの炎'];
// engine.js の HAMMERS の critByStar(できのよさ 0〜3 ごとの会心率 %)と同じ
const CRIT_HAMMER = { copper:[1.0,1.1,1.2,2.0], iron:[1.5,1.6,1.7,2.5], silver:[2.0,2.1,2.2,3.0],
                      platinum:[2.5,2.6,2.7,3.5], super:[3.0,3.1,3.2,4.0], miracle:[3.3,3.4,3.5,4.3],
                      light:[3.6,3.7,3.8,4.6] };
const CRIT_TRAIT_NAME = { kaishin:'威力会心率上昇', shuchu:'集中力変化', tataki:'たたき変化', modori:'戻り' };
const CRIT_HAMMER_NAME = { copper:'銅', iron:'鉄', silver:'銀', platinum:'プラチナ', super:'超', miracle:'奇跡', light:'光' };
// 装備の名前(集計を分ける単位)。職人スキルの会心アップは Lv30 で上限なので、Lv30 以上はまとめる
function critEquip_(level, hammer, star){
  const lv = Number(level) || 0;
  return (CRIT_HAMMER_NAME[hammer] || String(hammer)) + '★' + star + (lv >= 30 ? '' : ' Lv' + lv);
}
// 上乗せの無い会心率(割合)。職人スキルの会心アップ + コツをつかんでいる(+1.0%) + ハンマー(engine.js と同じ)
function critBase_(level, hammer, star){
  const lv = Number(level) || 0;
  const passive = (lv >= 10 ? 0.1 : 0) + (lv >= 20 ? 0.2 : 0) + (lv >= 30 ? 0.3 : 0);
  const h = CRIT_HAMMER[hammer]; const s = Number(star);
  return (passive + 1.0 + (h && h[s] !== undefined ? h[s] : 0)) / 100;
}
// 1局の手順から打撃を取り出し、add(打撃) に渡す。
// 打撃 = { sit: 状況, cls: 技の種類, crit: 会心か, base: 基礎の会心率, cr: 見込みの会心率, both: 会心でも会心でなくても出る値か(新しい版だけ) }
function critHitsOf_(trait, level, hammer, star, steps, add){
  const base = critBase_(level, hammer, star);
  let cur = null, pend = [], hsOn = false;
  const flush = () => { pend.forEach(add); pend = []; };
  const sitOf = (t, lit) => (trait === 'kaishin' && lit) ? '点灯' :
                            (trait === 'shuchu' && t % 200 === 0 && t % 400 !== 0) ? '会心ターン' : 'ふつう';
  for(const st of steps || []){
    if(!st || typeof st !== 'object') continue;
    if(st.t === 'exec'){
      flush();
      cur = {};
      const at = st.at || {}, list = Array.isArray(st.steps) ? st.steps : [];
      const start = at.temp === 1000 && Array.isArray(at.masses) && at.masses.every(v => v === 0);
      const cnt = {};
      list.forEach(s => (s.tg || []).forEach(m => { cnt[m] = (cnt[m] || 0) + (s.sk === 'みだれ打ち' ? 2 : 1); }));
      let t = at.temp;
      list.forEach((s, k) => {
        const hitting = CRIT_SKIP.indexOf(s.sk) < 0 && (s.tg || []).length > 0;
        (s.tg || []).forEach(m => {
          cur[m] = (cnt[m] > 1 || !hitting) ? { skip: true }
                 : { sk: s.sk, t, lit: k === 0 && st.lit === m, sure: hsOn, start: start && k === 0 };
        });
        if(hitting) hsOn = false;                      // 必殺の効果は、次に叩いた手で消える
        if(s.sk === 'ヘパイトスの炎') hsOn = true;
        t = s.tempAfter;
      });
      continue;
    }
    if(st.t === 'undo'){ pend = []; cur = null; continue; }   // 取り消した手の値は数えない
    if(st.t !== 'val' || st.red || st.amb) continue;
    let h;
    if(st.sk !== undefined && st.hitTemp !== undefined){        // 新しい版
      h = { sk: st.sk, t: st.hitTemp, lit: !!st.lit, sure: Number(st.cr) >= 1, cr: Number(st.cr), both: !!st.both };
      // 開始直後の1手は特性が乗らない(古い版と同じく、手順の側で判断する)
      const c = cur && cur[st.mass]; if(c && c.start) h.start = true;
    } else {
      h = cur && cur[st.mass];
    }
    if(cur) cur[st.mass] = null;                                 // 同じマスの値は1回だけ数える
    if(!h || h.skip || h.sure || h.start || CRIT_SKIP.indexOf(h.sk) >= 0 || typeof st.crit !== 'boolean') continue;
    const sit = sitOf(h.t, h.lit), cls = CRIT_AIM.indexOf(h.sk) >= 0 ? 'ねらい系' : 'それ以外';
    const mult = 1 + (sit === '会心ターン' ? 4 : 0) + (sit === '点灯' ? 4 : 0) + (cls === 'ねらい系' ? 6 : 0);
    pend.push({ sit, cls, crit: st.crit, base, cr: h.cr !== undefined ? h.cr : Math.min(1, base * mult),
                both: h.both, isNew: h.cr !== undefined });
  }
  flush();
}
// 記録の行(シートの値)から集計を作る。rows は「記録」シートの2行目以降
function critAggregate_(rows){
  const col = n => HEAD.indexOf(n);
  const iTrait = col('地金特性'), iLv = col('職人Lv'), iHam = col('ハンマー'), iStar = col('できのよさ'),
        iRes = col('結果'), iJson = col('手順(JSON)');
  const groups = {}, byTrait = {}, byEquip = {};
  let records = 0, bad = 0, hits = 0;
  for(const r of rows){
    if(r[iRes] === '試験') continue;
    let d;
    try{ d = JSON.parse(r[iJson]); }catch(e){ bad++; continue; }
    const trait = r[iTrait];
    const equip = critEquip_(r[iLv], r[iHam], r[iStar]);
    records++; byTrait[trait] = (byTrait[trait] || 0) + 1; byEquip[equip] = (byEquip[equip] || 0) + 1;
    critHitsOf_(trait, r[iLv], r[iHam], r[iStar], d && d.steps, h => {
      const k = equip + '|' + trait + '|' + h.sit + '|' + h.cls;
      const g = groups[k] || (groups[k] = { equip, base: h.base, trait, sit: h.sit, cls: h.cls, n: 0, crit: 0, sumBase: 0, sumCr: 0,
                                            sumVar: 0, nAll: 0, critAll: 0, nOld: 0, nBoth: 0, critBoth: 0 });
      g.nAll++; hits++; if(h.crit) g.critAll++;
      // 判定に使うのは、会心かどうかを値で区別できる打撃だけ(新しい版の記録で both でないもの)。
      // 実戦の記録(2026-10-09 までの253局)では、どちらとも取れる値(both)は会心でない側に入れられやすかった
      // (集中力変化・ねらい系: both 117回で 41% 対 見込み 55%、z=-3.1。区別できる値 270回は 52% 対 52%)。
      // 古い版の記録は both が分からないので、判定には入れない(数だけ控える)。
      if(!h.isNew){ g.nOld++; return; }
      if(h.both){ g.nBoth++; if(h.crit) g.critBoth++; return; }
      g.n++; if(h.crit) g.crit++;
      g.sumBase += h.base; g.sumCr += h.cr; g.sumVar += h.cr * (1 - h.cr);
    });
  }
  // 局の多い装備から並べる(同じ装備の中は 地金特性・状況・技 の順)
  const list = Object.keys(groups).map(k => groups[k]).sort((a, b) =>
    (byEquip[b.equip] - byEquip[a.equip]) || (a.equip < b.equip ? -1 : a.equip > b.equip ? 1 : 0) ||
    ((a.trait + a.sit + a.cls) < (b.trait + b.sit + b.cls) ? -1 : (a.trait + a.sit + a.cls) > (b.trait + b.sit + b.cls) ? 1 : 0));
  return { generated: new Date().toISOString(), records, recordsByTrait: byTrait, recordsByEquip: byEquip, badRows: bad, hits, groups: list };
}
// 実測の会心の回数が、エンジンの見込みの会心率どおりに出た場合の誤差の中か。
// z = (会心の回数 − 見込みの会心率の合計) ÷ √(見込みの会心率×(1−見込み) の合計)。|z| < 2 なら誤差の範囲(約95%)
function critCheck_(g){
  if(!g.n || !(g.sumVar > 0)) return { z: '', verdict: '' };
  const z = (g.crit - g.sumCr) / Math.sqrt(g.sumVar);
  const verdict = g.n < 30 ? '少ない' : Math.abs(z) < 2 ? '誤差の範囲' : (z > 0 ? '多い' : '少なめ') + '(ずれ)';
  return { z, verdict };
}
// 実測の会心率の95%の範囲(ウィルソンの方法)
function critRange_(crit, n){
  if(!n) return ['', ''];
  const p = crit / n, z = 1.96, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
function critSummary_(){
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET);
  const rows = sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues() : [];
  return critAggregate_(rows);
}
// メニューから: 「会心の集計」シートを書き直す
function updateCritSheet(){
  const s = critSummary_();
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CRIT_SHEET) || ss.insertSheet(CRIT_SHEET);
  sh.clear();
  const head = ['装備(ハンマー★できのよさ)', '基礎の会心率', '地金特性', '状況', '技', '叩いた回数(判定に使う)', '会心の回数',
                '会心率(実測)', '実測の95%の範囲(下)', '実測の95%の範囲(上)', '会心率(エンジンの見込み)',
                '見込みとの差のz', '判定', '基礎に対する倍率(実測)', '基礎に対する倍率(エンジン)',
                '除いた: どちらとも取れる値', '除いた: 古い版の記録'];
  const body = s.groups.map(g => { const ck = critCheck_(g), rg = critRange_(g.crit, g.n);
    return [g.equip, g.base, CRIT_TRAIT_NAME[g.trait] || g.trait, g.sit, g.cls, g.n, g.crit, g.n ? g.crit / g.n : '', rg[0], rg[1], g.n ? g.sumCr / g.n : '',
            ck.z, ck.verdict, g.sumBase ? g.crit / g.sumBase : '', g.sumBase ? g.sumCr / g.sumBase : '', g.nBoth || 0, g.nOld || 0]; });
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  if(body.length){
    sh.getRange(2, 1, body.length, head.length).setValues(body);
    sh.getRange(2, 2, body.length, 1).setNumberFormat('0.0%');
    sh.getRange(2, 8, body.length, 4).setNumberFormat('0.0%');
    sh.getRange(2, 12, body.length, 1).setNumberFormat('0.00');
    sh.getRange(2, 14, body.length, 2).setNumberFormat('0.00');
  }
  const eq = Object.keys(s.recordsByEquip).sort((a, b) => s.recordsByEquip[b] - s.recordsByEquip[a]);
  sh.getRange(body.length + 3, 1, 1, 2).setValues([['集計した対局', s.records]]);
  sh.getRange(body.length + 4, 1, 1, 2).setValues([['装備ごとの対局', eq.map(k => k + ' ' + s.recordsByEquip[k]).join(' / ')]]);
  sh.getRange(body.length + 5, 1, 1, 2).setValues([['判定の見方', '見込みとの差のzが±2の中なら、エンジンの会心率と誤差の範囲で一致(叩いた回数30未満は「少ない」)。'
    + '判定には、会心かどうかを値で区別できる打撃だけを使う(どちらとも取れる値は会心でない側に入れられやすいため)']]);
  sh.getRange(body.length + 6, 1, 1, 2).setValues([['更新した日時', new Date()]]);
  sh.setFrozenRows(1);
}
// GET: 集計の数字だけを返す(10分ごとに作り直す)
function doGet(e){
  const cache = CacheService.getScriptCache();
  let txt = cache.get('critSummary');
  if(!txt){ txt = JSON.stringify(critSummary_()); try{ cache.put('critSummary', txt, 600); }catch(err){} }
  return ContentService.createTextOutput(txt).setMimeType(ContentService.MimeType.JSON);
}
function onOpen(){
  SpreadsheetApp.getUi().createMenu('鍛冶アドバイザー').addItem('会心の集計を更新', 'updateCritSheet').addToUi();
}
