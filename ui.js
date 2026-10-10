/* =====================================================================
   画面(鍛冶アドバイザー)
   ・描画、テンキー、設定、保存、起動処理。
   ・計算は engine.js の関数を呼ぶ。engine.js の後に読み込む。
   ===================================================================== */

/* ====== 点灯マスの選択(威力会心率上昇) ====== */
// 点灯マスの選択が必要な局面か。
// 威力会心率上昇の地金は200℃の倍数のたびに未到達マスから1つが光る。
// どのマスが光ったかで威力も会心率も変わるので、選んでもらわないと計算できない。
// 数値の入力待ちが残っている間は、入力を先に済ませてもらう(同時に2つ求めない)。
function needLitPick(){
  if(G.trait !== 'kaishin') return false;
  if(isStartState()) return false;            // 開始直後は地金特性が乗らない
  if(G.temp <= 0 || G.temp % 200 !== 0) return false;
  if(G.pending && G.pending.length) return false;
  if(litMassIndex !== null) return false;
  return G.masses.some(m => !m.off && m.current < m.zoneLow);
}
// 点灯マスを選べる状態か。未選択のときだけでなく、選んだ後も計算するまでは
// 別のマスをタップして選び直せるようにする(押し間違えの取り返しがつくように)。
function litPickMode(){
  if(G.trait !== 'kaishin') return false;
  if(isStartState()) return false;
  if(G.temp <= 0 || G.temp % 200 !== 0) return false;
  if(G.pending && G.pending.length) return false;
  if(G.rec) return false;                     // 計算した後は通常の盤面操作に戻す
  return G.masses.some(m => !m.off && m.current < m.zoneLow);
}
function pickLit(i){
  const m = G.masses[i];
  if(!m || m.off || m.current >= m.zoneLow) return;
  litMassIndex = i;
  GameLog.ev('lit', { mass: i + 1 });
  G.rec = null; G.plan = [];                  // 点灯が決まると推奨手が変わる
  G.msg = null;                               // 「タップしてください」の案内を消す
  renderAll(); save();
}

/* ====== 戻り(メーター減少)の予告 ====== */
// この温度に着いた後で戻りが起きるか(始まりの1000℃は打った後ではないので対象外)
function modoriAfter(nt){ return G.trait === 'modori' && nt > 0 && nt % 200 === 0; }
// steps の k 手目の後に戻りが起きうるか。値のあるマスが1つも無い間は減らせないので起きない
// (始まりの火力上げ2回で1600℃に着いた時など)。打つ手が挟まれば値が出るので、起きうるとみなす。
function modoriCanAt(steps, k){
  if(!modoriAfter(steps[k].tempAfter)) return false;
  return G.masses.some(m => m.current > 0) || steps.slice(0, k + 1).some(st => st.tg.length > 0);
}
// 推奨手を打った後に戻りの対象になりうるマス。打つマスの取りうる値を全て組み合わせて求める。
// 描画のたびに呼ばれるので、同じ推奨手・同じ盤面の間は結果を使い回す。
let _mdrCache = { key: null, val: null };
function modoriHint(){
  const r = G.rec;
  if(!r || !modoriAfter(r.nt)) return null;
  const key = r.sk.id + '|' + r.tg.join(',') + '|' + G.temp + '|' + G.masses.map(m => m.current).join(',');
  if(_mdrCache.key === key) return _mdrCache.val;
  const outcomes = {};
  for(const i of r.tg){
    const m = G.masses[i]; if(m.current >= m.zoneLow) continue;
    const rr = rollsForMass(r.sk, G.temp, G.trait, i); if(!rr) continue;
    const o = hitOutcomes(m.current, rr, m.zoneLow, m.zoneHigh);
    outcomes[i] = o.normal.concat(o.crit);
    // みだれ打ちは当たらないマスもある(2回以上当たる場合は見ない。目安の表示なので)
    if(r.sk.random) outcomes[i].push(m.current);
  }
  const T = possibleModoriTargets(G.masses, outcomes);
  const val = T.size ? T : null;            // 減らせるマスが無ければ戻りは起きない
  _mdrCache = { key, val };
  return val;
}

/* ====== 描画 ====== */
// バーの最大値(全マス共通)。使うマスのゾーン上限の最大値に少し余裕を足した値を自動で決める
// (手動設定でも、入れたゾーンに合わせて決まる。使わないマスはゾーンが0なので効かない)。
function barScaleMax(){
  let hi = 0;
  for(const m of G.masses) if(m.zoneHigh > hi) hi = m.zoneHigh;
  return Math.max(50, Math.ceil((hi * 1.15) / 10) * 10);
}

// そのマスについて、バー上の各マーカー位置を求める。
// 推奨技の有無にかかわらず常に表示する(基準の技は推奨手、無ければ たたく)。
//   緑   = 成功ゾーン
//   青   = 選んだ技を通常ロールで打った時の到達範囲(最小〜最大)
//   赤   = 同じ技で会心(2倍)が出た時の到達範囲(最小〜最大)
//   白   = 現在値
function markersFor(m, skill, massIdx){
  const lo = m.zoneLow, hi = m.zoneHigh;
  // バーの左端は常に0に固定する。ゾーン付近だけを拡大すると
  // 「どこまで進んだか」の実感が持てないため、0からの絶対位置で示す。
  // バーの目盛りは全マス共通にする。
  // マスごとに終点が違うと、同じ長さでも意味が変わって比較できないため。
  // 既定は全マスのゾーン上限のうち最大値に余裕を持たせた値。設定で変更できる。
  const scaleMin = 0;
  const scaleMax = barScaleMax();
  const pct = v => Math.max(0, Math.min(100, (v-scaleMin)/(scaleMax-scaleMin)*100));

  const out = {
    zone:[pct(lo), pct(hi)], cur:pct(m.current),
    blue:null, red:null,
    raw:{ lo, hi, cur:Math.round(m.current) }
  };

  if(skill && skill.key){
    // 点灯マスは前進量が2倍。共通のロールで描くと、盤面のバーが実際の半分の幅になる
    const r = (massIdx === undefined) ? getRollCandidates(skill, G.temp, G.trait, false)
                                      : rollsForMass(skill, G.temp, G.trait, massIdx);
    if(r){
      const n0=m.current+r[0], n1=m.current+r[r.length-1];
      const c0=m.current+2*r[0], c1=m.current+2*r[r.length-1];
      out.blue = [pct(n0), pct(n1)];
      out.red  = [pct(c0), pct(c1)];
      out.raw.blue = [Math.round(n0), Math.round(n1)];
      out.raw.red  = [Math.round(c0), Math.round(c1)];
    }
  }
  return out;
}

function traitNote(){
  if(G.trait === 'shuchu') return `<div class="mk-note">
      <div><b class="mk-boost">★ 会心率+400%</b> 温度が200の倍数(400の倍数を除く)。
           会心率が5倍になる代わりに消費集中力が1.5倍。狙い打ちを撃つ好機。</div>
      <div><b class="mk-half">◆ 消費半減</b> 温度が400の倍数。
           消費集中力が半分になる。超4連打ちなど重い技を撃つ好機。</div></div>`;
  if(G.trait === 'tataki') return `<div class="mk-note">
      <div><b class="mk-boost">◎ 威力2倍</b> 温度が400の倍数。
           前進量が倍になる。超4連打ちなど多マス技を乗せたい。</div>
      <div><b class="mk-weak">▽ 威力1/2</b> 温度が200の倍数(400の倍数を除く)。
           前進量が半分。仕上げの微調整には使えるが、大きく進めたい時は避ける。</div></div>`;
  if(G.trait === 'modori'){
    const r = modoriRange();
    return `<div class="mk-note">
      <div><b class="mk-weak">↩ 戻り</b> 温度が200の倍数になると、1マスの値が${r.min}〜${r.max}減る。
           ゾーンを超えたマスがあれば上限から一番離れたマス、無ければ値のある未到達のマスのうちゾーンに一番近いマスが対象。
           超過しても取り戻せる。値が0のマスは減らないので、全マス0の間(始まりの火力上げなど)は起きない。</div></div>`;
  }
  if(G.trait === 'kaishin') return `<div class="mk-note">
      <div><b class="mk-boost">✦ 点灯</b> 温度が200の倍数。未到達のマスから1つが光る。
           光ったマスだけ威力2倍・会心率+${Math.round(LIT_BONUS*100)}%。盤面でタップして指定する。</div></div>`;
  return '';
}

function renderBoard(){
  const mdr = modoriHint();                  // 推奨手の後に戻りで減りそうなマス
  const el = document.getElementById('board');
  const hiTg = G.rec ? G.rec.tg : [];
  // バーの基準技:推奨手が出ていればその技の伸び幅を表示する。
  // まだ計算していない(または温度操作が推奨された)場合は「たたく」を既定とする。
  const skill = (G.rec && G.rec.sk && G.rec.sk.key) ? G.rec.sk
              : SKILLS.find(s=>s.id==='tataku');
  let html = '';
  // 使わないマスは出さない(利用者の指示)。段・列が丸ごと使われていなければ詰め、
  // 1マスだけ空く所は見えない空白にして、ほかのマスの上下左右の並び(技の形)は崩さない。
  const usedRow = r => !G.masses[2*r].off || !G.masses[2*r+1].off;
  const rows = Math.ceil(G.masses.length / 2);          // 縦3行(6マス)か4行(8マス)
  const usedCol = c => Array.from({ length: rows }, (_, r) => r).some(r => !G.masses[2*r+c].off);
  const anyUsed = G.masses.some(m => !m.off);
  // 1列だけの盤は、段の幅をふつうの盤の半分にして中央に置く(ゲージが横いっぱいに伸びないように)
  const oneCol = anyUsed && (usedCol(0) !== usedCol(1));
  for(let row=0; row<rows; row++){
    if(anyUsed && !usedRow(row)) continue;
    html += `<div class="brow${oneCol ? ' half' : ''}">`;
    for(let col=0; col<2; col++){
      if(anyUsed && !usedCol(col)) continue;
      const i = row*2+col;
      const m = G.masses[i];
      if(anyUsed && m.off){
        const gap = `<div class="cell gap" aria-hidden="true"></div>`, bar = `<div class="bar-wrap ${col===0?'left':'right'}"></div>`;
        html += col===0 ? bar+gap : gap+bar;
        continue;
      }
      const mk = markersFor(m, skill, i);
      const flip = (col===0);
      const st = m.off ? ''
               : m.current > m.zoneHigh ? 'over'
               : m.current >= m.zoneLow ? 'done' : '';
      const pick = litPickMode();
      const pickable = pick && !m.off && m.current < m.zoneLow;
      const cls = (m.off ? ' off' : '')
                + (!m.off && hiTg.includes(i)?' hi':'') + (st?' '+st:'')
                + (!m.off && G.pending.includes(i)?' need':'')
                + (pickable ? ' litpick' : '')
                + (pick && !pickable && !m.off ? ' litdim' : '')
                + (litMassIndex === i ? ' lit' : '')
                + (!m.off && mdr && mdr.has(i) ? ' mdr' : '');
      // ゲージの上のゾーンの数字(マスの中と同じ)と、下の伸びの数字は出さない(利用者の指示)。色の帯と印だけで見る
      // マスの札(入力・対象・戻り・点灯)。点灯マスを叩く手のように重なることがあるので、並べて全部出す
      // (前は CSS で1つだけ出していたため、点灯マスでは「対象」「入力」が「点灯」に隠れていた)
      const tags = m.off ? '' :
          (G.pending.includes(i) ? '<span class="tag">入力</span>' : hiTg.includes(i) ? '<span class="tag">対象</span>' : '')
        + (mdr && mdr.has(i) ? '<span class="tag mdr">戻り</span>' : '')
        + (litMassIndex === i ? '<span class="tag lit">点灯</span>' : '');
      const barBlock = m.off ? `<div class="bar-wrap ${flip?'left':'right'}"></div>` :
        `<div class="bar-wrap ${flip?'left':'right'}">${buildBar(mk, flip)}</div>`;
      const cell =
        `<div class="cell${cls}${G.fx && G.fx.i===i ? ' fx-'+G.fx.k : ''}"${
            m.off ? '' : (pick ? (pickable ? ` onclick="pickLit(${i})"` : '')
                               : ` onclick="openPad('mass',${i})"`)}>
           <div class="idx">マス${i+1}${tags}</div>
           <div class="cur">${Math.round(m.current)}</div>
           <div class="zn"><span>${m.zoneLow}</span><span>${m.zoneHigh}</span></div>
         </div>`;
      html += flip ? barBlock+cell : cell+barBlock;
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

function buildBar(mk, flip){
  // マーカーごとに座標を反転させると重なり順や位置がずれるため、
  // 座標計算は常に左→右で行い、左列だけバー全体をCSSでミラーする。
  const band = (a,b,cls) => {
    const lo=Math.min(a,b), hi=Math.max(a,b);
    return `<i class="${cls}" style="left:${lo}%;width:${Math.max(hi-lo,1)}%"></i>`;
  };
  const line = (v,cls) => `<i class="${cls}" style="left:${v}%"></i>`;
  let s = '';
  if(mk.zone) s += band(mk.zone[0], mk.zone[1], 'm-green');
  if(G.showRange && mk.blue) s += band(mk.blue[0], mk.blue[1], 'm-blue');
  if(G.showRange && mk.red)  s += band(mk.red[0],  mk.red[1],  'm-red');
  // 現在値は0から今の位置までを塗り、右端に白線を立てる
  s += `<i class="m-cur" style="width:${Math.max(mk.cur,0.5)}%"></i>`;
  s += line(mk.cur,'m-curline');
  return `<div class="bar${flip?' flip':''}">${s}</div>`;
}

const TRAIT_LABEL = {shuchu:'集中力変化', none:'特性なし', tataki:'たたき変化',
                     modori:'戻り', kaishin:'威力会心率上昇'};
function traitLabel(t){ return TRAIT_LABEL[t] || t; }

// 必殺の状態。[G.hs, G.hsUsed]。G.hs: 0 = 使えない / 1 = チャージ / 2 = 使った後で、次に叩く技が必ず会心(engine.js の HS)
const HS_STATES = { none:[0, false], charged:[1, false], active:[2, true], used:[0, true] };
const HS_LABEL = { none:'なし', charged:'チャージ', active:'効果中', used:'使用済み' };
function hsKey(){ return G.hs === 1 ? 'charged' : G.hs === 2 ? 'active' : G.hsUsed ? 'used' : 'none'; }
function renderHeader(){
  // 複数商材を扱うので、今どれを打っているかを最上段に常時出す
  const pp = PRESETS[G.preset];
  const nm = document.getElementById('v-name'), gp = document.getElementById('v-grp');
  if(nm) nm.textContent = G.preset === 'custom' ? '手動設定' : (pp ? pp.name : '');
  if(gp) gp.textContent = G.preset !== 'custom' && pp && pp.grp ? pp.grp : '';
  // 手動設定のときだけ、使用中のマス数と地金特性をヘッダに出す
  const chip = document.getElementById('v-cust');
  if(chip){
    if(G.preset === 'custom'){
      const on = G.masses.filter(m=>!m.off).length;
      const set = G.masses.some(m=>!m.off && m.zoneHigh > 0);
      chip.textContent = set ? (on + 'マス/' + traitLabel(G.trait)) : '要設定';
      chip.style.display = '';
    }else chip.style.display = 'none';
  }
  const hm = HAMMERS[G.hammerId];
  document.getElementById('v-gear').textContent =
    (hm ? hm.name : G.hammerId) + '★' + G.star + ' / Lv' + G.level;
  document.getElementById('v-temp').textContent = G.temp;
  document.getElementById('v-focus').textContent = G.focus;
  // 必殺: なし → (チャージが来たら選ぶ)チャージ → (使う)効果中 → (叩く)使用済み
  const hsBox = document.getElementById('hsBox'), hsV = document.getElementById('v-hs');
  if(hsBox && hsV){
    hsV.textContent = HS_LABEL[hsKey()];
    hsBox.classList.toggle('on', G.hs === 1 || G.hs === 2);
    hsBox.classList.toggle('used', !G.hs && !!G.hsUsed);
  }
  const b = [];
  // 出すのは点灯中のマス(今の状態)だけ。温度の効果と「開始直後」は、見ても分かりにくく打ち方も変わらないので出さない。
  // 数値の入力待ちと光ったマスの選択は、マスの「入力」の印・入力の画面・主ボタンで分かるので出さない(どれも利用者の指示)
  if(!G.pending.length && !needLitPick() && litMassIndex !== null)
    b.push(`<span class="badge rate">マス${litMassIndex+1}が点灯中${litPickMode()?'(別のマスをタップで選び直し)':''}</span>`);
  const bx = document.getElementById('badges');
  bx.innerHTML = b.join('');
  bx.style.display = b.length ? '' : 'none';
}

function renderSkills(){
  const rows = ['<tr><th>技</th><th>ロール</th><th class="cst">消費</th><th class="cst">会心</th></tr>'];
  // 技の倍率(SKILL_MULT)の小さい順に並べる。同じ倍率は覚えるレベルの順のまま、数値の無い温度操作は最後
  const order = s => s.key ? SKILL_MULT[s.key] : 99;
  const list = SKILLS.filter(s => s.lv <= G.level).sort((a, b) => order(a) - order(b))
    .map(s => ({ s, r: s.key ? getRollCandidates(s, G.temp, G.trait, false) : null }));
  // ロールは1つずつ同じ幅の枠に右そろえで入れ、桁が違っても列がそろうようにする。枠の幅は表の中で一番長い桁数に合わせる
  const digits = Math.max(1, ...list.filter(x => x.r).map(x => String(x.r[x.r.length-1]).length));
  document.getElementById('skTable').style.setProperty('--rvw', digits + 'ch');
  for(const { s, r } of list){
    const c = actualCostOf(s, G.temp, G.trait);
    const cr = s.key ? computeCritRate(s,G.level,G.hammerId,G.star,G.trait,G.temp) : 0;
    rows.push(`<tr><td>${s.name}</td><td class="rolls">${r ? r.map(v => `<span class="rv">${v}</span>`).join('') : '—'}</td>`
      + `<td class="cst">${c}</td><td class="cst">${s.key?(cr*100).toFixed(0)+'%':'—'}</td></tr>`);
  }
  // 表は技ごとなのでマス単位の値を出せない。点灯中はその旨を添えて、表の値を鵜呑みにさせない
  if(G.trait === 'kaishin' && litMassIndex !== null)
    rows.push(`<tr><td colspan="4" style="font-size:11px;color:var(--dim)">`
      + `上は通常マスの値。点灯中のマス${litMassIndex+1}はロール2倍・会心率+${Math.round(LIT_BONUS*100)}%</td></tr>`);
  document.getElementById('skTable').innerHTML = rows.join('');
  // 温度の効果の説明(会心率+400%・消費半減など)。毎手見るものではないので、技一覧の中に置く
  const note = document.getElementById('skNote'); if(note) note.innerHTML = traitNote();
}

// 推奨手の後に戻りが起きる時の一行。どのマスが減りそうかも出す
function modoriLine(){
  const t = modoriHint();
  if(!t) return '';
  const names = [...t].sort((a,b)=>a-b).map(i => 'マス' + (i+1));
  return `<div class="rec-sub mdr-line">↩ このあと戻り: ${names.length ? names.join('か') + 'が減る見込み' : '減るマスなし'}</div>`;
}
// 全マスがゾーンに入った後のやり直し(endRedo)。やめた場合と比べた大成功の見込みを添える
function redoLine(r){
  if(!r.redo || typeof r.er !== 'number') return '';
  const pc = x => Math.round(x * 100) + '%';
  return `<div class="rec-sub">ゾーン内からもう一度ねらう: 大成功の見込み ${pc(r.erStop)} → ${pc(r.er)}</div>`;
}
// 打ち始めの温度操作(火力上げなど)が、この先も同じ手に決まる回数。まとめて「火力上げ ×3」と出し、主ボタン1回で反映する。
// 全マスが0の間だけ見る(まだ叩いていないので結果が確定していて、手を決めるのも先読みを使わない決め打ちになる)。
// 途中の温度ごとにアプリの判断(mcPrepare)をそのまま呼び、先読み無しで同じ手に決まる時だけ数えるので、
// 1回ずつ「使った」を押した時と推奨手は同じになる。手順(G.plan)の先頭に並ぶ同じ手の数も超えない。
// 威力会心率上昇は200℃の倍数で光ったマスを選ぶ必要があるので、そこで止める。
function recChain(){
  const r = G.rec;
  if(!r || r.sk.key || r.tg.length || !G.plan.length || G.plan[0].name !== r.sk.name) return 1;
  if(G.masses.some(m => !m.off && m.current !== 0)) return 1;
  const saved = { temp: G.temp, focus: G.focus, prev: PREV_SK, lit: litMassIndex };
  let k = 1;
  try{
    let t = r.nt, f = G.focus - r.c;
    while(k < G.plan.length && G.plan[k].name === r.sk.name && !G.plan[k].tg.length && G.plan[k].temp === t){
      if(G.trait === 'kaishin' && t % 200 === 0) break;
      G.temp = t; G.focus = f; PREV_SK = r.sk.id; litMassIndex = null;
      const ms = G.masses.map(m => ({ current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh }));
      const prep = mcPrepare(ms, f, t, PARAMS, cfgOf());
      if(prep.move === undefined || !prep.move || prep.move.sk.id !== r.sk.id || prep.move.c !== G.plan[k].cost) break;
      k++; f -= prep.move.c; t = prep.move.nt;
    }
  } finally {
    G.temp = saved.temp; G.focus = saved.focus; PREV_SK = saved.prev; litMassIndex = saved.lit;
  }
  return k;
}
// 主ボタン1回で反映する手の数(まとめていなければ1)
function recCount(){ return (G.rec && G.recN > 1 && G.plan.length >= G.recN) ? G.recN : 1; }

function renderRec(){
  const el = document.getElementById('rec');
  if(G.pending.length){ el.innerHTML = ''; return; }
  if(!G.rec){
    // 計算を押す直前に目に入る所なので、ゲームと合わせる案内はここに出す。要るのは打ち始める前
    // (ゲームの途中でアプリを開いた時など)だけなので、1手でも反映したら出さない
    const hint = G.msg || (G.hist.length ? '' : 'ゲームと違う時は、盤面・温度・集中力を押して直す');
    el.innerHTML = hint ? '<div class="rec-empty">' + hint + '</div>' : '';
    return;
  }
  const r = G.rec;
  const tgt = r.sk.hs ? '必殺: 次に叩く技は当たったマスがすべて会心'
            : r.sk.random ? `マス${r.tg.map(i=>i+1).join('・')}のどこかにランダムで4回`
            : r.tg.length ? r.tg.map(i=>'マス'+(i+1)).join('・') : '';
  const sub = x => [tgt, x].filter(Boolean).join(' / ');
  const cr = r.sk.key ? computeCritRate(r.sk,G.level,G.hammerId,G.star,G.trait,G.temp) : 0;
  // 点灯マスを含む手は、そのマスだけ会心率が違う。1つの数字に丸めると誤解を招くので分けて出す
  let critTxt = r.sk.key ? (G.hs === 2 ? ' / 必ず会心(必殺)' : ' / 会心'+(cr*100).toFixed(0)+'%') : '';
  if(r.sk.key && G.trait === 'kaishin' && litMassIndex !== null && r.tg.includes(litMassIndex)){
    const crL = critForMass(r.sk, cfgOf(), G.temp, litMassIndex);
    const others = r.tg.filter(i => i !== litMassIndex);
    critTxt = others.length
      ? ` / 会心${(cr*100).toFixed(0)}%(点灯マス${litMassIndex+1}は${(crL*100).toFixed(0)}%・威力2倍)`
      : ` / 会心${(crL*100).toFixed(0)}%(点灯・威力2倍)`;
  }
  // この手を打った後に残る集中力と温度も出す。
  // 仕上げに何発残せるかの判断に直結するため。
  const n = recCount();
  if(n > 1){
    // 打ち始めの火力上げなど、続けて同じ手に決まる温度操作はまとめて出す(recChain)
    const steps = G.plan.slice(0, n), cost = steps.reduce((a, x) => a + x.cost, 0), leftN = G.focus - cost;
    const warnN = leftN < 40 ? ' style="color:var(--ember)"' : '';
    el.innerHTML = `<div class="rec-main">
      <div class="rec-skill">${r.sk.name} ×${n}</div>
      <div class="rec-sub">${sub(`消費${cost}(${steps.map(x => x.cost).join('・')})`)}</div>
      <div class="rec-sub">実行後 → <b${warnN}>集中力 ${leftN}</b> / ${steps[n-1].tempAfter}℃</div>
    </div>`;
    return;
  }
  const leftF = G.focus - r.c;
  const warn = leftF < 40 ? ' style="color:var(--ember)"' : '';
  el.innerHTML = `<div class="rec-main">
      <div class="rec-skill">${r.sk.name}</div>
      <div class="rec-sub">${sub(`消費${r.c}${critTxt}`)}</div>
      <div class="rec-sub">実行後 → <b${warn}>集中力 ${leftF}</b> / ${r.nt}℃</div>${modoriLine()}${redoLine(r)}
    </div>`;
  // 1手ずつ進める時は下の主ボタン(打った)、まとめて打った時は手順の「ここまで打った」を使う。
}

function renderDetail(){
  const el = document.getElementById('detail'), acc = document.getElementById('planAcc');
  // 手順が無い時(計算前・入力の後)は、見出しだけ残っても意味が無いので欄ごと隠す
  if(acc) acc.style.display = G.plan.length ? '' : 'none';
  if(!G.plan.length){ el.innerHTML = ''; return; }
  let h = '';
  // 打った手の履歴は出さない。取り消しは「直前の反映を取り消す」で足りる。
  if(G.plan.length){
    // 2手目以降は1手目の結果で変わるが、見出しの「(目安)」で足りるので、決まり文句は出さない(利用者の指示。
    // 前は「※あくまでも目安です」と「ここまで打った」の使い方を常に添えていた)
    let f = G.focus;
    // 理想値が絞れるのは「会心が理想値ちょうどで止まりうる位置」で叩いた時だけ。
    // 会心で最大まで伸ばしても成功ゾーンに届かない位置なら、結果は理想値と無関係に
    // 決まるので、何手まとめて実行しても失う情報は無い。
    // 逆に届きうる手を含めてまとめると、その分の判定ができなくなる。
    // 途中の値は分からないので、最大ロールの会心が続いた場合の上限で判定する。
    // 判定が壊れるのは、同じマスを2打以上まとめてしまい、なおかつ
    // そのマスが成功ゾーンに入った場合だけ。
    //   1打しか当たっていない → 前後の値が分かるので何手まとめても分解できる
    //   ゾーンに入っていない   → 本会心が起きていないので失う情報が無い
    // 途中の値は分からないので、最大ロールの会心が続いた場合の上限で判定する。
    const ub = G.masses.map(m => m.current);          // 各マスの取りうる最大値
    const cnt = {};                                   // まとめた中で叩いた回数
    const info = []; let cutAt = -1;
    G.plan.forEach((st,i)=>{
      const sk = skillByName(st.name);
      const rr = (sk && sk.key) ? getRollCandidates(sk, st.temp, G.trait, false) : null;
      let lost = false;
      if(rr){
        st.tg.forEach(j => {
          // 点灯が効くのは今の手番(1手目)だけ。以降は温度が変わっていて点灯は引き直される
          const rj = (i === 0) ? (rollsForMass(sk, st.temp, G.trait, j) || rr) : rr;
          const top = 2 * rj[rj.length-1];
          const m = G.masses[j];
          // 手順に載っている時点で、その手番では未到達のマス。
          // 上限値で対象から外すと、まだ遠いマスの打撃回数を数え落とす。
          cnt[j] = (cnt[j] || 0) + 1;
          ub[j] = Math.min(m.zoneHigh, ub[j] + top);
          // 2打目以降で、かつゾーンに入りうるなら判定不能になる
          if(cnt[j] >= 2 && ub[j] >= m.zoneLow) lost = true;
        });
      }
      if(lost && cutAt < 0) cutAt = i;
      info.push({ safe: cutAt < 0 || i < cutAt });
    });
    h += '<div class="plist-body">' + G.plan.map((st,i)=>{
      f -= st.cost;
      const mark = (st.mk ? ` <b class="mk-${st.mk.k}">${st.mk.l}</b>` : '')
                 + ((i === 0 ? !!modoriHint() : modoriCanAt(G.plan, i)) ? ' <b class="mk-weak">↩ このあと戻り</b>' : '');
      const cls  = (st.mk ? ' on-'+st.mk.k : '') + (i===0?' first':'');
      const tg   = st.name === 'みだれ打ち' ? 'ランダムで4回'
                 : st.tg.length ? st.tg.map(x=>'マス'+(x+1)).join('・') : '';
      const note = '';
      const btn  = (f < 0 || i === 0) ? ''   // 1手目は主ボタンと同じなので出さない(利用者の指示)
        : `<button class="pexec" onclick="applyExecuted(${i+1})">
             <span class="t">${st.tg.length ? 'ここまで打った' : 'ここまで使った'}</span>
             <span class="s">${st.tempAfter}℃ / 集中${f}</span>
             ${note}
           </button>`;
      const bar  = (i === cutAt)
        ? '<div class="dup-line">ここまでで数値の入力を推奨</div>' : '';
      return bar + `<div class="pstep${cls}">
          <span class="n">${i+1}</span>
          <div class="pinfo">
            <div class="pname">${st.name}${mark}</div>
            ${tg ? `<div class="ptg">${tg}</div>` : ''}
          </div>${btn}
        </div>`;
    }).join('') + '</div>';
  }
  el.innerHTML = h;
}

// ゲージの色の見方を出す・隠す
function toggleLegend(){
  const l = document.getElementById('legend'), b = document.getElementById('lgBtn');
  l.hidden = !l.hidden; b.setAttribute('aria-expanded', String(!l.hidden)); b.classList.toggle('on', !l.hidden);
}

function renderAll(){ renderHeader(); renderBoard(); renderSkills(); renderRec();
  renderExec(); renderDetail(); syncCalcButton(); }

// 数値の入力待ち・点灯待ちの間はボタンを押せなくし、何をすべきかをラベルに出す。
// ボタンの状態はここだけで決める(複数箇所で書き換えると後から呼ばれた側が勝ち、
// 入力待ちなのに押せる状態へ戻っていた)。
function syncCalcButton(){
  const btn = document.getElementById('calcBtn');
  if(!btn || CALC_BUSY) return;
  const a = primaryAction();
  btn.disabled = !a.run;
  // 大きく「何をするか」、その下に小さく補足を出す(1行に詰め込むと読みにくかった)
  // (クラス名は .main だと PC 版の2列レイアウトの .main と衝突するので btn- を付ける)
  btn.innerHTML = '<span class="btn-main">' + a.label + '</span>' + (a.sub ? '<span class="btn-sub">' + a.sub + '</span>' : '');
  btn.classList.toggle('done-step', a.kind === 'exec');
  btn.classList.toggle('wait', a.kind === 'lit');
  // 取り消しは、直前の「打った」を戻せる時だけ主ボタンの左に出す
  const ub = document.getElementById('undoBtn');
  if(ub) ub.style.display = G.undoSnap ? '' : 'none';
}
// 画面下の主ボタンが今すべきこと。利用者が迷わないよう、次の操作をいつも1つだけ示す。
//   入力待ち   → 結果の入力を開く(計算はさせない。打つ前の値で計算してしまうため)
//   点灯待ち   → 押せない(盤面の光ったマスをタップしてもらう)
//   推奨手あり → 「打った」= 手順の1手目を実行済みとして反映する
//   それ以外   → 推奨手を計算
function primaryAction(){
  if(G.pending.length){
    const n = G.pending.length;
    return { kind:'input', label:'結果を入力', sub:`マス${G.pending[0]+1}` + (n > 1 ? `・残り${n}マス` : ''),
             run: () => openPad('mass', G.pending[0]) };
  }
  if(needLitPick()) return { kind:'lit', label:'光ったマスをタップしてください' };
  if(G.rec && G.plan.length){
    const n = recCount();
    return { kind:'exec', label: G.rec.tg.length ? '打った' : (n > 1 ? `${n}回使った` : '使った'),
             sub: G.rec.tg.length ? '結果の入力へ' : '推奨手を計算',
             run: () => applyExecuted(n) };
  }
  const active = G.masses.filter(m => !m.off);
  // 戻りの地金では超過も取り戻せるので、超過が残る間は続ける(boardDone)
  if(active.length && boardDone(G.masses, G.trait)) return { kind:'end', label:'全マス到達' };
  return { kind:'calc', label:'推奨手を計算', run: doCalc };
}
function onPrimary(){
  if(CALC_BUSY) return;
  const a = primaryAction();
  if(a.run) a.run();
}

/* ====== 実行済みの反映 ======
   実プレイでは推奨手を何手かまとめて打ってから再計算する。
   何手目まで打ったかを選ぶだけで、温度と集中力は自動で差し引く。
   マスの数値だけはゲーム画面を見ないと分からないので、手入力を促す。 */
function renderExec(){
  const el = document.getElementById('execPanel');

  if(G.pending.length){
    const names = G.pending.map(i=>'マス'+(i+1));
    // 入力は主ボタンから順に進む。別の順で入れたい時は盤面のマスをタップすればよい
    el.innerHTML =
      `<div class="exec"><div class="need-box">
         <div class="d">${names.join('・')} の結果待ち(温度・集中力は反映済み)</div>${G.msg ? `<div class="d">${G.msg}</div>` : ''}
       </div></div>`;
    return;                                   // 主ボタンと取り消しの状態は syncCalcButton が決める
  }
  el.innerHTML = '';
}

function applyExecuted(k){
  if(!G.plan.length || k<1 || k>G.plan.length) return;
  const steps = G.plan.slice(0, k);
  const cost = steps.reduce((a,x)=>a+x.cost, 0);
  if(cost > G.focus){ alert('集中力が足りません'); return; }

  // 点灯マスは今の手番だけのもの。温度が変わると引き直されるので、実行前に控える。
  // 手順は200℃の倍数で打ち切っているので、点灯が効くのは1手目だけ。
  const litNow = (G.trait === 'kaishin') ? litMassIndex : null;
  // やり直せるように、変更前の状態を控える
  ensurePosts();
  G.undoSnap = { temp:G.temp, focus:G.focus, lit:litMassIndex, hs:G.hs, hsUsed:G.hsUsed,
    masses:G.masses.map(m=>({...m})), pending:G.pending.slice(), histLen:G.hist.length,
    posts:G.posts.map(p=>p.slice()), obs:(G.obs||[]).slice() };
  steps.forEach((st, k) => G.hist.push({name:st.name, tg:st.tg.slice(), tempAfter:st.tempAfter,
                                        lit: k === 0 ? litNow : null}));
  GameLog.ev('exec', { steps: steps.map(st => ({ sk: st.name, tg: st.tg.map(i => i + 1), tempAfter: st.tempAfter })),
                       cost, lit: litNow === null ? null : litNow + 1 });

  G.focus -= cost;
  G.temp   = steps[steps.length-1].tempAfter;

  // 叩いたマスは値が変わっているはずなので、手入力の対象にする。
  // 温度操作だけの手は対象マスが無いので何も増えない。
  // 理想値を絞り込むには「1回の打撃ごとの前後の値」が要る。
  // まとめて実行して同じマスを2回以上叩いた場合は分解できないので、
  // そのマスの推定は諦めて分布を一様に戻す。
  // みだれ打ちはどのマスに何回当たったか分からないので、分解できない扱いにする
  const cnt = {};
  const isRandom = st => { const sk = skillByName(st.name); return !!(sk && sk.random); };
  steps.forEach(st => st.tg.forEach(i => { cnt[i] = (cnt[i]||0) + (isRandom(st) ? 2 : 1); }));
  ensurePosts();
  if(!G.obs) G.obs = new Array(G.masses.length).fill(null);
  let t2 = G.undoSnap.temp;
  const firstOf = {};
  // 必殺: 使った後の最初の打撃は、当たったマスがすべて会心(会心率 1)。打つと効果が消える
  let hsNow = G.hs || 0;
  steps.forEach((st, k) => {
    const sk = skillByName(st.name);
    const sure = hsNow === 2 && !!(sk && sk.key);
    if(sk && sk.hs){ hsNow = 2; G.hsUsed = true; }
    else if(sure) hsNow = 0;
    st.tg.forEach(i => {
      if(firstOf[i] === undefined && sk && sk.key){
        // その手の時点の特性状態を再現してから求める。
        // 点灯マスはロール2倍・会心率+400%なので、候補値もその前提で作る。
        // (これを怠ると、点灯マスを叩いた後の選択肢が通常の値しか出ず、正しく入力できない)
        const saved = simFirstMove;
        simFirstMove = (st.traitOn === undefined) ? saved : !st.traitOn;
        const lit = (k === 0 && litNow !== null && i === litNow);
        firstOf[i] = { before: G.masses[i].current,
                       rolls: getRollCandidates(sk, st.temp, G.trait, lit),
                       cr: sure ? 1 : computeCritRate(sk, G.level, G.hammerId, G.star, G.trait, st.temp, lit),
                       name: st.name, key: sk.key, temp: st.temp, lit,
                       mult: getPowerMultiplier(G.trait, st.temp, lit) };
        simFirstMove = saved;
      }
    });
  });
  G.hs = hsNow;
  const hit = new Set(G.pending);
  steps.forEach(st => st.tg.forEach(i => hit.add(i)));
  for(const i of hit){
    // 2打以上まとめた場合は分解できないので更新を見送るだけ。
    // それまでに絞り込んだ分布は有効なので捨てない。
    if(cnt[i] > 1 || !firstOf[i]) G.obs[i] = null;
    else if(!G.obs[i]) G.obs[i] = firstOf[i];
    else G.obs[i] = null;
  }
  // ---- 戻り ----
  // 200℃の倍数に着いた手の後は、ゲームが自動で1マスを減らす。利用者には戻りの後の値を
  // 1回だけ入れてもらい、どのマスがいくつ減ったかはこちらで判断する。
  let msgAfter = null;
  const mdSteps = steps.filter((st, k) => modoriCanAt(steps, k));
  if(mdSteps.length){
    const multi = [...hit].some(i => !G.obs[i]);
    if(mdSteps.length === 1 && mdSteps[0] === steps[steps.length-1] && !multi){
      const outcomes = {};
      for(const i of hit){
        const ob = G.obs[i], m = G.masses[i];
        const o = hitOutcomes(ob.before, ob.rolls, m.zoneLow, m.zoneHigh);
        outcomes[i] = o.normal.concat(o.crit);
      }
      const T = possibleModoriTargets(G.masses, outcomes);
      // 対象が1マスに決まり、かつ戻りが起きない場合(全マスがゾーンに入る・0で減らせない)が無い時だけ確定
      const sure = T.size === 1 && !T.none, range = modoriRange();
      for(const t of T){
        if(hit.has(t)){
          G.obs[t].modori = sure ? 'yes' : 'maybe'; G.obs[t].range = range;
          // 実際に起こりうる値だけを候補にする(対象になる時/ならない時の、打った直後の値)
          G.obs[t].canRed = [...T.asTarget[t]]; G.obs[t].canPlain = [...T.asOther[t]];
        }
        else{
          // 打っていないのに減るマス。入力の対象に加える
          G.obs[t] = { modoriOnly: true, before: G.masses[t].current, name: '戻り',
                       modori: sure ? 'yes' : 'maybe', range };
          hit.add(t);
        }
      }
    } else {
      // 戻りが2回以上起きた、または同じマスを2打以上まとめた場合は分解できない
      for(const i of hit) G.obs[i] = null;
      msgAfter = '戻りで値が変わったマスは、盤面のマスをタップして直してください';
    }
  }
  if(steps.some(isRandom))
    msgAfter = 'みだれ打ちの後は、各マスの今の値' + (mdSteps.length ? '(戻りがあれば戻った後の値)' : '')
             + 'を入れてください。当たらなかったマスはそのまま「決定」';
  // 打っていないのに戻るかもしれないマスを先に聞く(候補が少なく、減っていれば他のマスの候補を絞れる)
  G.pending = [...hit].sort((a,b) => ((G.obs[b] && G.obs[b].modoriOnly) ? 1 : 0) - ((G.obs[a] && G.obs[a].modoriOnly) ? 1 : 0) || a - b);

  G.rec = null; G.plan = []; clearLit();
  // 入力するものが無い手(温度操作だけ)なら、そのまま次の一手まで出す
  if(!G.pending.length){ G.msg = null; renderAll(); doCalc(); save(); return; }
  G.msg = msgAfter;
  renderAll(); save();
  // 叩いたマスの結果入力をそのまま開く(ゲームで結果を見たらすぐ選べるように)
  openPad('mass', G.pending[0]);
}

function undoExec(){
  if(!G.undoSnap) return;
  GameLog.ev('undo');
  const u = G.undoSnap;
  G.temp = u.temp; G.focus = u.focus;
  litMassIndex = (typeof u.lit === 'number') ? u.lit : null;
  G.hs = u.hs || 0; G.hsUsed = !!u.hsUsed;
  G.masses = u.masses.map(m=>({...m}));
  G.pending = u.pending.slice();
  if(typeof u.histLen === 'number') G.hist.length = u.histLen;
  // 理想値の分布も戻す。戻さないと、取り消した打撃の観測が残ったままになる
  if(Array.isArray(u.posts)) G.posts = u.posts.map(p=>p.slice());
  if(Array.isArray(u.obs))   G.obs = u.obs.slice();
  G.undoSnap = null;
  G.rec = null; G.plan = []; G.msg = null;
  renderAll(); save();
}

/* ====== 計算 ====== */
let CALC_BUSY = false;
let CALC_AGAIN = false;   // 計算中に、もう一度の計算を求められた(doCalc が呼ばれた)
// 計算に使う局面(盤面・温度・集中力・必殺・点灯・直前の手・入力待ち・設定)。計算中にこれが変わった時
// (温度・集中力・マスの値の手直し、必殺の切り替え、手順の「ここまで打った」、取り消しなど)は、その計算の手は別の局面のものなので出さない
function calcKey(){
  return JSON.stringify([G.preset, G.trait, G.level, G.hammerId, G.star, G.temp, G.focus, G.hs || 0, litMassIndex,
    G.hist.length, G.pending, G.masses.map(m => [m.current, m.zoneLow, m.zoneHigh, !!m.off])]);
}
function setCalcProgress(pct, label){
  const btn = document.getElementById('calcBtn');
  const bar = document.getElementById('calcBar');
  if(btn) btn.textContent = label;
  if(bar){
    bar.style.display = (pct === null) ? 'none' : '';
    if(pct !== null) bar.firstChild.style.width = Math.round(pct*100) + '%';
  }
}
async function doCalc(){
  // 探索中の二重押しを防ぐ。計算中に求められた時は控えておき、局面が変わっていれば終わった所で計算し直す
  if(CALC_BUSY){ CALC_AGAIN = true; return; }
  // 叩いたマスの数値が未入力のまま計算すると、打つ前の値で次の手を決めてしまう
  if(G.pending.length){ renderAll(); return; }
  // 点灯マスが未指定のまま計算すると、威力2倍も会心率+400%も乗らない別物の手が出る
  // 何をすればよいかは主ボタンに「光ったマスをタップしてください」と出る(推奨の欄には同じ文を出さない。利用者の指示)
  if(needLitPick()){
    G.msg = null;
    renderAll();
    return;
  }
  CALC_BUSY = true; CALC_AGAIN = false;
  G.recN = 1;
  let key0 = null, stale = false;
  const moved = () => calcKey() !== key0;
  const btn = document.getElementById('calcBtn');
  btn.disabled = true;
  setCalcProgress(0, '先読み中 0%');
  await new Promise(r=>setTimeout(r, 20));
  try{
    key0 = calcKey();
    const cfg = cfgOf();
    HS = G.hs || 0;                   // 必殺の状態(先読みの Worker には mcSnapshot で渡る)
    // 直前に打った手(火力上げの直後に冷やし込み、のような打ち消し合う温度操作を選ばないため)
    const lastH = G.hist.length ? G.hist[G.hist.length - 1] : null, lastSk = lastH ? skillByName(lastH.name) : null;
    PREV_SK = lastSk ? lastSk.id : null;
    const ms = G.masses.map(m=>({current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh}));
    // 戻りの地金では、全マスがゾーンに入った後も、もう一度ねらった方が大成功の見込みが上がる時はその手を出す
    // 必殺が残っていれば先に使う(必ず会心なので、やり直しより確実)
    const done = boardDone(ms, G.trait) && G.temp > 0;
    const redo = done ? (hsEndMove(ms, G.focus, G.temp, cfg, PARAMS) || endRedo(ms, G.focus, G.temp, PARAMS, cfg)) : null;
    if(redo){
      G.rec = redo; G.msg = null;
      await MCPool.plan(ms, cfg, G.rec);
      if(!moved()) GameLog.ev('rec', { sk: G.rec.sk.name, tg: G.rec.tg.map(i => i + 1), redo: true });
    } else if(boardDone(ms, G.trait)){
      G.rec=null; G.plan=[]; G.msg='<span style="color:var(--green)">全マス到達 — 仕上げてください</span>';
    } else if(G.temp<=0){
      G.rec=null; G.plan=[]; G.msg='温度切れ';
    } else {
      G.msg=null;
      // 先読みは Worker に分担させる(使えない環境では画面側で計算する。どちらも同じ手になる)
      G.rec = await MCPool.strat(ms, G.focus, G.temp, PARAMS, cfg, (done, total, n, ext)=>{
        setCalcProgress(done/total, `先読み中 ${Math.round(done/total*100)}% (候補${n}手${ext ? '・接戦のため追加中' : ''})`);
      });
      setCalcProgress(1, '手順を組み立て中…');
      await new Promise(r=>setTimeout(r, 0));
      await MCPool.plan(ms, cfg, G.rec);
      G.recN = recChain();
      if(G.rec && !moved()) GameLog.ev('rec', Object.assign({ sk: G.rec.sk.name, tg: G.rec.tg.map(i => i + 1) }, G.recN > 1 ? { n: G.recN } : {}));
    }
    // 計算中に局面が変わっていたら、古い局面で決めた手は出さない(記録もしない)。
    // 変えた側(手直し・必殺の切り替えなど)が推奨手を消して案内を出しているので、案内はそのまま残す
    stale = moved();
    if(stale){ G.rec = null; G.plan = []; G.recN = 1; }
    renderAll();
  }catch(e){
    document.getElementById('rec').innerHTML =
      '<div class="rec-empty">計算に失敗しました: '+e.message+'</div>';
  }
  setCalcProgress(null, '推奨手を計算');
  CALC_BUSY=false; syncCalcButton();
  // 計算中に計算を求められていて(必殺の切り替え・最後の値の入力など)、局面が変わっていれば計算し直す。
  // 同じ局面なら今の結果で足りる
  const again = CALC_AGAIN && stale;
  CALC_AGAIN = false;
  if(again) doCalc();
}

/* ====== テンキー ====== */
// 電卓と同じ操作感にする。
//   数字だけ入力して決定 → その値をそのまま設定
//   ＋ / － を押してから数字を入力 → 現在値に加算 / 減算
let padTarget=null, padIdx=null, padOp=null, padBuf='';

// 打撃後に起こりうる値を全て列挙する。結果は必ずこの中のどれかになる。
function candidateValues(idx){
  const ob = G.obs && G.obs[idx];
  if(!ob) return null;
  const m = G.masses[idx];
  // 戻りで減った後の値(減る量は範囲内のどれか)
  const minus = (arr, red) => { const out = new Set();
    for(const v of arr) for(let a = red.min; a <= red.max; a++) out.add(Math.max(0, v - a));
    return [...out].sort((a,b)=>a-b); };
  const groups = [];
  if(ob.modoriOnly){
    // 打っていないが戻りで減るマス
    if(ob.modori === 'maybe') groups.push({ label:'変わっていない', cls:'n', vals:[ob.before], crit:null, red:false });
    groups.push({ label:'戻りで減った', cls:'r', vals: minus([ob.before], ob.range), crit:null, red:true });
    return { groups, name: ob.name, modori: true };
  }
  if(!ob.rolls) return null;
  // 会心が理想値ちょうどで止まる場合も「会心が出た」に含める(値はゾーン内の任意の位置になりうる)
  const o = hitOutcomes(ob.before, ob.rolls, m.zoneLow, m.zoneHigh);
  if(ob.cr >= 1) o.normal = [];       // 必殺の効果中は必ず会心なので、会心でない値は出さない
  // 戻りの対象になる/ならない時に実際に起こりうる値だけに絞る(戻りの規則で決まるため)
  const only = (arr, allow) => allow ? arr.filter(v => allow.includes(v)) : arr;
  if(ob.modori !== 'yes'){
    const plainN = ob.modori ? only(o.normal, ob.canPlain) : o.normal;
    const plainC = ob.modori ? only(o.crit, ob.canPlain) : o.crit;
    if(plainN.length) groups.push({ label:'会心が出なかった', cls:'n', vals:plainN, crit:false, red:false });
    if(plainC.length) groups.push({ label:'会心が出た', cls:'c', vals:plainC, crit:true, red:false });
  }
  if(ob.modori){
    const redN = minus(only(o.normal, ob.canRed), ob.range), redC = minus(only(o.crit, ob.canRed), ob.range);
    if(redN.length) groups.push({ label:'会心なし・戻りで減った', cls:'r', vals: redN, crit:false, red:true });
    if(redC.length) groups.push({ label:'会心あり・戻りで減った', cls:'rc', vals: redC, crit:true, red:true });
  }
  return { groups, name: ob.name, modori: !!ob.modori };
}
// 候補を選んだとき。会心の有無まで受け取って理想値の分布を更新する
// 値の変化に応じた合図を1回だけ仕込む。
// ゾーンに入った=緑の波紋、超過=横揺れ、それ以外=一度だけ脈動。
function markFx(idx, before, after){
  const m = G.masses[idx];
  let k = 'pulse';
  if(after > m.zoneHigh) k = 'shake';
  else if(after >= m.zoneLow && before < m.zoneLow) k = 'enter';
  G.fx = { i: idx, k };
  setTimeout(()=>{ if(G.fx && G.fx.i === idx) G.fx = null; }, 700);
}
// red: 戻りで減った後の値を選んだ(減る前の値は範囲内のどれか)
function pickValue(idx, val, wasCrit, red){
  if(!Number.isFinite(val)) return;      // 想定外の値では状態を壊さない
  const ob = G.obs && G.obs[idx];
  // 会心率の集計用(tools/log-collector.gs): 叩いた技・叩いた時の温度・点灯マスか・見込みの会心率と、
  // その値が会心でも会心でなくても出る値か。どの打撃か分からない値(まとめて実行して2回以上叩いた等)は amb
  let hit = { amb: true };
  if(ob && ob.rolls && !ob.modoriOnly){
    const m = G.masses[idx], o = hitOutcomes(ob.before, ob.rolls, m.zoneLow, m.zoneHigh);
    hit = { sk: ob.name, hitTemp: ob.temp, lit: !!ob.lit, cr: Math.round(ob.cr * 10000) / 10000,
            both: o.normal.includes(val) && o.crit.includes(val) };
  }
  GameLog.ev('val', Object.assign({ mass: idx + 1, before: G.masses[idx].current, val, crit: !!wasCrit, red: !!red }, hit));
  // 打っていないマスの戻りは理想値と無関係なので、推定は更新しない
  if(ob && ob.rolls && !ob.modoriOnly) updatePost(idx, ob.before, ob.rolls, ob.cr, val, wasCrit, red ? ob.range : undefined);
  markFx(idx, G.masses[idx].current, val);
  G.masses[idx].current = val;
  if(G.obs) G.obs[idx] = null;
  G.pending = G.pending.filter(i => i !== idx);
  // 戻りは1回に1マスだけ。減ったマスが分かったら、他のマスは減っていない
  if(red && G.obs){
    for(const j of G.pending.slice()){
      const o = G.obs[j]; if(!o || !o.modori) continue;
      if(o.modoriOnly){ G.obs[j] = null; G.pending = G.pending.filter(x => x !== j); }   // 値はそのまま
      else { o.modori = null; }
    }
  }
  closePad();
  // 残りがあれば続けて次のマスの入力を開く(1マスごとに盤面へ戻らなくて済むように)
  if(G.pending.length){ renderAll(); save(); openPad('mass', G.pending[0]); return; }
  G.msg = null;
  // 先に盤面へ反映する。計算が点灯待ちで止まる場合、ここで描かないと
  // 最後に入れた値が盤面に出ないまま点灯選択の案内だけが出てしまう。
  renderAll();
  doCalc();                       // 入力が揃った時点で次の一手は確定できる
  save();
}
function openPad(kind, idx){
  padTarget=kind; padIdx=idx; padBuf=''; padOp=null;
  let title='';
  const cand = (kind === 'mass') ? candidateValues(idx) : null;
  if(kind==='mass'){
    // 見出しはマスの番号だけ(利用者の指示)。戻りの後の値を入れる時は、入れる値を間違えないようにその旨を添える
    title = `マス${idx+1}` + (cand && cand.modori ? '(戻りの後の値)' : '');
  } else if(kind==='temp'){
    title='温度(℃)';
  } else {
    title='残り集中力';
  }
  document.getElementById('padTitle').textContent=title;
  const box = document.getElementById('padCand');
  const keys = document.getElementById('padKeys');
  if(box){
    if(kind === 'temp'){
      box.innerHTML = tempCandHtml();
      box.style.display = 'block';
      if(keys) keys.style.display = 'none';
    } else if(cand){
      const btn = (v,g) => `<button class="cand${g.crit ? ' crit' : ''}${g.red ? ' red' : ''}"`
        + ` onclick="pickValue(${idx},${v},${g.crit},${g.red})">${v}</button>`;
      box.innerHTML =
        cand.groups.map(g => `<div class="cand-grp"><span class="cand-h ${g.cls}">${g.label}</span>`
          + `<div class="cand-row">${g.vals.map(v => btn(v, g)).join('')}</div></div>`).join('')
      + `<button class="cand-more" onclick="showKeys()">一覧に無い値を自分で入力する</button>`;
      box.style.display = 'block';
      if(keys) keys.style.display = 'none';       // 候補があるならテンキーは畳む
    } else {
      box.innerHTML=''; box.style.display='none';
      if(keys) keys.style.display = '';
    }
  }
  updatePad();
  document.getElementById('modal').classList.add('show');
  // 温度の一覧は、開いた時に今の温度(50℃刻みでなければ一番近い値)を真ん中に置く
  const tw = kind === 'temp' && document.getElementById('tempWheel');
  const near = tw && tw.querySelector('.tw-item.near');
  if(near) tw.scrollTop = near.offsetTop - (tw.clientHeight - near.offsetHeight) / 2;
}

// 温度は技で 50℃ 刻み(−50・−150・−300・+300)にしか動かないので、テンキーで4桁打つ代わりに
// 50℃ 刻みの値を並べて1回押すだけで入れられるようにする。全部(45個ほど)を並べると多すぎて見にくいので、
// 一度に5つ見えるスクロールの一覧にし、開いた時は今の温度を真ん中に置く(手直しで入れる温度は、たいてい今の近く。
// 利用者の指示)。上は 2200℃ か、今の温度から火力上げ1回分の高い方まで。
function tempCandHtml(){
  const cur = G.temp;
  const top = Math.max(2200, Math.ceil((cur + 300) / 50) * 50);
  const vals = []; for(let v = 0; v <= top; v += 50) vals.push(v);
  const near = Math.min(top, Math.max(0, Math.round(cur / 50) * 50));
  return `<div class="tw" id="tempWheel">${vals.map(v =>
        `<button class="tw-item${v === cur ? ' cur' : ''}${v === near ? ' near' : ''}" onclick="pickTemp(${v})">${v}</button>`).join('')}</div>`
    + `<button class="cand-more" onclick="showKeys()">一覧に無い値を自分で入力する</button>`;
}
function pickTemp(v){
  if(v === G.temp){ closePad(); return; }   // 今と同じ値なら何も変えない(推奨手も消さない)
  padBuf = String(v); padOp = null; commit();
}
function showKeys(){
  const k = document.getElementById('padKeys');
  const b = document.getElementById('padCand');
  if(k) k.style.display = '';
  if(b) b.style.display = 'none';
}
function closePad(){ document.getElementById('modal').classList.remove('show'); }

function key(k){
  if(k==='del'){
    if(padBuf) padBuf=padBuf.slice(0,-1);
    else padOp=null;               // 数字が無ければ演算子を取り消す
  } else if(k==='plus' || k==='minus'){
    padOp = (padOp===k) ? null : k;  // 同じキーをもう一度押すと解除
    padBuf='';
  } else if(padBuf.length<5){
    padBuf+=k;
  }
  updatePad();
}

function curValue(){
  return padTarget==='mass' ? Math.round(G.masses[padIdx].current)
       : padTarget==='temp' ? G.temp : G.focus;
}

function updatePad(){
  const cur = curValue();
  const n = Number(padBuf||'0');
  let pre='', val=padBuf||'0', res='';
  if(padOp==='plus'){  pre = `${cur} ＋`; res = cur + n; }
  else if(padOp==='minus'){ pre = `${cur} －`; res = Math.max(0, cur - n); }
  document.getElementById('padPre').textContent = pre;
  document.getElementById('padVal').textContent = val;
  const rEl = document.getElementById('padRes');
  if(rEl) rEl.textContent = padOp ? `= ${res}` : `現在 ${cur}`;
  const p=document.getElementById('kPlus'), m=document.getElementById('kMinus');
  if(p) p.classList.toggle('on', padOp==='plus');
  if(m) m.classList.toggle('on', padOp==='minus');
}

function commit(){
  const cur = curValue();
  const n = Number(padBuf||'0');
  let v;
  if(padOp==='plus') v = cur + n;
  else if(padOp==='minus') v = cur - n;
  else v = padBuf==='' ? cur : n;    // 何も入力していなければ現状維持
  v = Math.max(0, v);
  GameLog.ev('edit', { target: padTarget, mass: padTarget === 'mass' ? padIdx + 1 : null, val: v });
  let lastInput = false;                     // この入力で入力待ちが全て埋まったか
  let wasPendingMass = false;                // 入力待ちのマスを入れたか(続けて次を開くため)
  if(padTarget==='mass'){
    markFx(padIdx, G.masses[padIdx].current, v);
    G.masses[padIdx].current = v;
    // 手入力は会心の有無が分からないので理想値の絞り込みには使わないが、
    // 打撃の記録(打つ前の値とロール候補)はここで使い終わったので必ず消す。
    // 残すと、次にこのマスを叩いた時に候補ボタンが出ず、
    // 再びこのマスを開いた時には古い値を元にした候補が並んでしまう。
    if(G.obs) G.obs[padIdx] = null;
    const wasPending = G.pending.includes(padIdx);
    wasPendingMass = wasPending;
    G.pending = G.pending.filter(i => i !== padIdx);
    if(!G.pending.length) G.msg = null;
    lastInput = wasPending && !G.pending.length;
  }
  else if(padTarget==='temp') G.temp = v;
  else G.focus = v;
  // 温度・集中力・マス値を手で直した時点で、前の計算結果は別局面のものになる。
  // 点灯マスは温度で決まるので、温度を直した時だけ消す。
  // (マス値や集中力の修正で消すと、同じ手番なのに点灯の選び直しを求めてしまう)
  G.rec = null; G.plan = [];
  if(padTarget === 'temp') clearLit();
  closePad(); renderAll(); save();
  // 候補ボタンから選んだ時(pickValue)と同じく、残りがあれば続けて開き、揃ったら次の一手まで出す
  if(wasPendingMass && G.pending.length){
    openPad('mass', G.pending[0]);
  }
  if(lastInput) doCalc();
}

/* ====== 設定 ====== */
function readSettings(){
  G.level = Number(document.getElementById('s-level').value)||80;
  G.hammerId = document.getElementById('s-hammer').value;
  G.star = Number(document.getElementById('s-star').value);
  G.trait = document.getElementById('s-trait').value;
}
function applySettings(){
  const before = G.level + '/' + G.hammerId;
  const traitBefore = G.trait;
  readSettings();
  // 地金特性を切り替えたら点灯の記録は意味を失う。
  // 残すと威力会心率上昇に戻したとき、古い点灯が復活する。
  if(G.trait !== traitBefore) clearLit();
  // レベル・ハンマー・★・地金特性はロールにも会心率にも効く。
  // 変更後に古い推奨手と勝率を残すと、別条件の計算結果を見せることになる。
  G.rec = null; G.plan = [];
  const cap = FOCUS_CAP[G.level] || FOCUS_CAP[80];
  const full = cap + (HAMMERS[G.hammerId]?HAMMERS[G.hammerId].focusBonus:0);
  // 打ち始めた後に設定を触っても、進行中の集中力を勝手に満タンへ戻さない。
  // 上限が変わる項目(レベル・ハンマー)を変えた時だけ確認して入れ替える。
  const started = G.hist.length > 0 || G.masses.some(m=>m.current > 0);
  if(!started){
    G.focus = full;
  }else if(before !== G.level + '/' + G.hammerId){
    if(confirm('集中力の上限が変わります。現在値を ' + full + ' に入れ直しますか?\n' +
               'キャンセルすると今の ' + G.focus + ' のまま続けます。')) G.focus = full;
  }
  renderAll(); save();
}

// 素材の選択が変わった時(v は選んだ商材のキー)。手動設定ならゾーン入力欄を出す。
function onPresetChange(v){
  const box = document.getElementById('zoneEdit');
  if(v === 'custom'){
    box.style.display = 'block';
    // 手動設定は今の盤面(直前の素材のゾーン)を引き継いで始まる。許容誤差は使うマスの数で決まる。
    G.preset = 'custom';
    applyThreshold();
    renderZoneRows();
    // ゾーンの入力欄は設定の中にあるので、選んだら開いて見せる
    const acc = document.getElementById('setAcc');
    if(acc) acc.open = true;
    renderAll(); save();
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  // 打ち始めた後は、結果を選んでから切り替える(選ばなければ切り替えない)
  if(GameLog.active()){ askOutcome(() => switchPreset(v)); return; }
  const started = G.hist.length > 0 || G.masses.some(m=>m.current > 0);
  // キャンセル時は G.preset を変えないので、見出しの商材名も入力欄もそのまま
  if(started && !confirm('素材を変えると盤面と履歴が最初に戻ります。よろしいですか?')) return;
  switchPreset(v);
}
function switchPreset(v){
  document.getElementById('zoneEdit').style.display = 'none';
  G.preset = v;
  // 素材ごとに地金特性が決まっているので、選択と同時に切り替える
  const p = PRESETS[v];
  if(p && p.trait){
    const sel = document.getElementById('s-trait');
    if(sel) sel.value = p.trait;
  }
  resetAll();
}

// 各マスのゾーン入力欄を描く
function renderZoneRows(){
  const el = document.getElementById('zoneRows');
  if(!el) return;
  markZoneDirty(false);
  document.querySelectorAll('#zoneSize button').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === G.masses.length));
  el.innerHTML = G.masses.map((m,i)=>{
    const on = !m.off;
    // 無効化したマスはゾーンを0にしているので、入力欄には控えを表示する
    const lo = on ? m.zoneLow  : (m.oLo || '');
    const hi = on ? m.zoneHigh : (m.oHi || '');
    return `<div class="zrow${on?'':' zoff'}" id="z-row-${i}">
       <input type="checkbox" class="zchk" id="z-on-${i}" ${on?'checked':''}
              onchange="onZoneToggle(${i})">
       <span class="zl">マス${i+1}</span>
       <input type="number" id="z-lo-${i}" value="${lo}" min="1" max="999"
              oninput="markZoneDirty()">
       <span class="zs">〜</span>
       <input type="number" id="z-hi-${i}" value="${hi}" min="1" max="999"
              oninput="markZoneDirty()">
     </div>`;}).join('');
  showZoneThreshold();
}
// 手動設定の盤の大きさ(6マス=3段 / 8マス=4段)。8マスにすると、マス7・8を使わない状態で足す(チェックを入れて使う)。
// 6マスに戻す時は、マス7・8を消す。盤の形が変わるので、盤面と履歴は最初に戻す。
function setCustomSize(n){
  if(G.preset !== 'custom' || (n !== 6 && n !== 8) || G.masses.length === n) return;
  if(n === 6 && G.masses.slice(6).some(m => !m.off) && !confirm('マス7・8の設定を消して、6マスの盤にします。よろしいですか?')) return;
  if(GameLog.active()){ askOutcome(() => resizeCustom(n)); return; }
  const started = G.hist.length > 0 || G.masses.some(m => m.current > 0);
  if(started && !confirm('盤の大きさを変えると、盤面と履歴が最初に戻ります。よろしいですか?')) return;
  resizeCustom(n);
}
function resizeCustom(n){
  if(n === 8) while(G.masses.length < 8) G.masses.push({ current:0, zoneLow:0, zoneHigh:0, off:true });
  else G.masses = G.masses.slice(0, 6);
  resetAll();                       // 手動設定はゾーンと使うマスを引き継いで、数値だけ最初に戻す
}
// 許容誤差はチェックの入ったマスの数で決まるので、入切に合わせてその場で出す
function showZoneThreshold(){
  const el = document.getElementById('z-th-auto');
  if(!el) return;
  let n = 0;
  for(let i = 0; i < G.masses.length; i++){ const c = document.getElementById('z-on-'+i); if(c ? c.checked : !G.masses[i].off) n++; }
  el.textContent = thresholdForMasses(n) + ' 以下で大成功(' + n + 'マス)';
}

// チェックの入切で行の見た目だけ切り替える(反映はボタンで行う)
function onZoneToggle(i){
  const row = document.getElementById('z-row-'+i);
  const on  = document.getElementById('z-on-'+i).checked;
  if(row) row.classList.toggle('zoff', !on);
  showZoneThreshold();
  markZoneDirty();
}

// 入力しただけではまだ盤面に入らないので、その旨を出す
function markZoneDirty(on){
  const d = document.getElementById('zoneDirty');
  if(d) d.style.display = (on === false) ? 'none' : '';
}

// 入力されたゾーンを盤面に反映する
function applyZones(){
  const warn = document.getElementById('zoneWarn');
  const next = [];
  for(let i=0;i<G.masses.length;i++){
    const on = document.getElementById('z-on-'+i).checked;
    const lo = Number(document.getElementById('z-lo-'+i).value);
    const hi = Number(document.getElementById('z-hi-'+i).value);
    if(!on){ next.push({i, on:false, lo, hi}); continue; }
    if(!isFinite(lo) || !isFinite(hi) || lo < 1 || hi < lo || hi > 999){
      if(warn){ warn.textContent = 'マス'+(i+1)+': 下限は1以上、上限は下限以上かつ999以下で入れてください。';
                warn.style.display = 'block'; }
      return;                                 // 1つでも不正なら何も反映しない
    }
    next.push({i, on:true, lo, hi});
  }
  if(!next.some(x=>x.on)){
    if(warn){ warn.textContent = '少なくとも1マスは使う設定にしてください。';
              warn.style.display = 'block'; }
    return;
  }
  if(warn) warn.style.display = 'none';
  for(const x of next){
    const m = G.masses[x.i];
    m.oLo = isFinite(x.lo) && x.lo > 0 ? x.lo : m.oLo;   // 控え(再有効化時の初期値)
    m.oHi = isFinite(x.hi) && x.hi > 0 ? x.hi : m.oHi;
    if(x.on){
      m.off = false; m.zoneLow = x.lo; m.zoneHigh = x.hi;
      if(m.current > x.hi + 50) m.current = 0;
    }else{
      // 使わないマスは「幅0のゾーンに到達済み」として扱う。
      // 既存の未到達判定(current < zoneLow)が全て自動で素通りするため、
      // 評価・終局判定・推奨のいずれにも影響しない。
      m.off = true; m.zoneLow = 0; m.zoneHigh = 0; m.current = 0;
    }
  }
  syncActiveMask();
  // 盤面の定義が変わったので点灯は選び直してもらう。
  // 残すと、外したマスや到達済みになったマスが「点灯中」のまま残る。
  clearLit();
  // 使わなくなったマスに実測値の入力要求が残ると、盤面に無いマスのボタンが出る
  G.pending = G.pending.filter(i => !G.masses[i].off);
  if(Array.isArray(G.obs)) G.masses.forEach((m,i)=>{ if(m.off) G.obs[i] = null; });
  G.preset = 'custom';
  applyThreshold();                  // 使うマスの数が変わるので、許容誤差も決め直す
  G.rec = null; G.plan = [];
  renderZoneRows(); markZoneDirty(false); renderAll(); save();
}

// G.masses の有効/無効を技の対象計算へ反映する
function syncActiveMask(){
  setActiveMask(G.masses.map(m => !m.off));
}

function confirmReset(){
  // 打ち始めた後は、結果(大成功/成功/失敗/途中でやめた)を選ばないとリセットできない
  if(GameLog.active()){ askOutcome(resetAll); return; }
  const started = G.hist.length > 0 || G.masses.some(m=>m.current > 0);
  if(started && !confirm('盤面・集中力・履歴をすべて初期状態に戻します。よろしいですか?')) return;
  resetAll();
}

function resetAll(){
  readSettings();
  const kind = G.preset || 'kagayaki';
  // 手動設定なら現在のゾーンを保持し、数値だけ戻す
  // 手動設定はやり直しても、入力したゾーンと使用マスの設定を引き継ぐ
  const keep = (kind === 'custom' && (G.masses.length === 6 || G.masses.length === 8))
    ? G.masses.map(m=>({lo:m.zoneLow, hi:m.zoneHigh, off:!!m.off, oLo:m.oLo, oHi:m.oHi}))
    : (PRESETS[kind] ? PRESETS[kind].zones : PRESETS.kagayaki.zones)
        .map(([lo,hi],i)=>({lo, hi, off: !!(PRESETS[kind] && PRESETS[kind].off && PRESETS[kind].off.includes(i))}));
  // 使わないマスは「幅0のゾーンに到達済み」として保持する(手動設定のマス非表示と同じ扱い)
  G.masses = keep.map(k=>({current:0, zoneLow:k.off?0:k.lo, zoneHigh:k.off?0:k.hi, off:k.off,
                           oLo:k.oLo, oHi:k.oHi}));
  syncActiveMask();
  applyThreshold();
  G.temp = 1000; clearLit();
  const cap = FOCUS_CAP[G.level] || FOCUS_CAP[80];
  G.focus = cap + (HAMMERS[G.hammerId]?HAMMERS[G.hammerId].focusBonus:0);
  G.rec=null; G.plan=[];
  G.pending=[]; G.undoSnap=null; G.msg=null; G.hist=[]; G.posts=null; G.obs=null;
  G.hs = 0; G.hsUsed = false;
  renderZoneRows();
  renderAll(); save();
}

/* ====== 保存 ====== */
const SKEY='kajiAdvisorStateV1';
function save(){
  try{ localStorage.setItem(SKEY, JSON.stringify({
    temp:G.temp, focus:G.focus, masses:G.masses,
    level:G.level, hammerId:G.hammerId, star:G.star, trait:G.trait, preset:G.preset, lit:litMassIndex,
    pending:G.pending, showRange:G.showRange, hist:G.hist, posts:G.posts, obs:G.obs, hs:G.hs, hsUsed:G.hsUsed
  })); }catch(e){}
}
function load(){
  try{
    const s=JSON.parse(localStorage.getItem(SKEY));
    if(!s||!s.masses||(s.masses.length!==6 && s.masses.length!==8)) return false;
    Object.assign(G,s);
    delete G.mc;                      // 旧版で保存された切り替え設定は使わない
    // 保存データの点灯が今の盤面で成立するか確かめてから戻す
    // (特性が違う・範囲外・使わないマス・到達済みなら捨てる)
    const L = s.lit;
    litMassIndex = (typeof L === 'number' && G.trait === 'kaishin' && G.masses[L]
                    && !G.masses[L].off && G.masses[L].current < G.masses[L].zoneLow) ? L : null;
    delete G.lit;
    G.masses.forEach(m => { if(m.off === undefined) m.off = false; });
    syncActiveMask();
    delete G.customThreshold;          // 以前の版で手入力した許容誤差は使わない(使うマスの数で決まる)
    applyThreshold();                 // 許容誤差は素材で決まる(手動設定は使うマスの数)
    if(!Array.isArray(G.pending)) G.pending = [];
    if(!Array.isArray(G.hist)) G.hist = [];
    if(G.hs !== 1 && G.hs !== 2) G.hs = 0;
    G.hsUsed = !!G.hsUsed;
    // 廃止した素材が保存データに残っていた場合は既定へ戻す
    if(G.preset !== 'custom' && !PRESETS[G.preset]) G.preset = 'kagayaki';
    if(typeof G.showRange !== 'boolean') G.showRange = true;
    G.undoSnap = null;   // 取り消しは同一セッション内だけ
    document.getElementById('s-level').value=G.level;
    document.getElementById('s-hammer').value=G.hammerId;
    document.getElementById('s-star').value=G.star;
    document.getElementById('s-trait').value=G.trait;
    delete G.barMax;                   // 以前の版で手入力したバーの最大値は使わない(自動で決まる)
    if(G.preset === 'custom'){
      const box = document.getElementById('zoneEdit');
      if(box) box.style.display = 'block';
      renderZoneRows();
    }
    return true;
  }catch(e){ return false; }
}

/* ====== 起動 ====== */
// 商材の選択。169商材を1つの一覧から探すのは長すぎるので、職人(武器・防具・道具鍛冶) ▶ 種類 ▶ 商材 の順にたどる。
// 職人の並びは出典の meluce.jp「ドラクエ10 職人ツール」のトップページと同じ 武器 → 防具 → 道具。
// 種類の並びは engine.js の CRAFT_ITEMS(同じサイトのデータの順)。種類の中の商材は作成レベルの高い順
// (利用者の指示。同じレベルは CRAFT_ITEMS の順)。開いた時は今の商材の種類の一覧から始め、
// 上の道しるべで前の段に戻る。大成功率の目安(PRESETS の rate)がある商材は、名前の横に出す。
// 目安をまだ測っていない商材は「検証中」と出す(利用者の指示)。
// その下に、先読みをしない打ち方(貪欲)で測った率を「簡易 ◯%」と薄い字で出す(PRESETS の greedy。全商材にある。利用者の指示)。
// 先読みの目安は実際に近い値、簡易は参考値(先読みが無い分、多くの商材で目安より低い)。
const PICK_JOBS = ['武器', '防具', '道具'];
const PICK_TREE = new Map();          // 職人 → 種類 → 商材のキーの並び
for(const j of PICK_JOBS) PICK_TREE.set(j, new Map());
for(const k of PRESET_ORDER){
  const p = PRESETS[k];
  if(!PICK_TREE.has(p.job)) PICK_TREE.set(p.job, new Map());
  const g = PICK_TREE.get(p.job);
  if(!g.has(p.grp)) g.set(p.grp, []);
  g.get(p.grp).push(k);
}
for(const g of PICK_TREE.values()) for(const ks of g.values())
  ks.sort((a, b) => (PRESETS[b].craft || 0) - (PRESETS[a].craft || 0));   // sort は同じ値の順を保つ
let PICK = { job: null, grp: null };
function openPicker(){
  const p = PRESETS[G.preset];
  PICK = (G.preset !== 'custom' && p && p.job) ? { job: p.job, grp: p.grp } : { job: null, grp: null };
  renderPicker();
  document.getElementById('pickModal').classList.add('show');
}
function closePicker(){ document.getElementById('pickModal').classList.remove('show'); }
function renderPicker(){
  const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const cur = PRESETS[G.preset];
  const crumbs = ['<button class="pk-crumb" data-nav="">職人</button>'];
  if(PICK.job) crumbs.push(`<button class="pk-crumb" data-nav="job">${esc(PICK.job)}鍛冶</button>`);
  if(PICK.grp) crumbs.push(`<span class="pk-crumb now">${esc(PICK.grp)}</span>`);
  document.getElementById('pkCrumbs').innerHTML = crumbs.join('<span class="pk-sep">▶</span>');
  let h = '';
  if(!PICK.job){
    h = '<div class="pk-grid jobs">';
    for(const [job, grps] of PICK_TREE){
      let n = 0; for(const ks of grps.values()) n += ks.length;
      const on = G.preset !== 'custom' && cur && cur.job === job;
      h += `<button class="pk-btn${on ? ' cur' : ''}" data-job="${esc(job)}">${esc(job)}鍛冶<small>${n}件</small></button>`;
    }
    h += '</div>';
    h += `<button class="pk-custom${G.preset === 'custom' ? ' cur' : ''}" data-key="custom">手動設定(ゾーンを自分で入れる)</button>`;
  }else if(!PICK.grp){
    h = '<div class="pk-grid">';
    for(const [grp, ks] of PICK_TREE.get(PICK.job)){
      const on = G.preset !== 'custom' && cur && cur.job === PICK.job && cur.grp === grp;
      h += `<button class="pk-btn${on ? ' cur' : ''}" data-grp="${esc(grp)}">${esc(grp)}<small>${ks.length}件</small></button>`;
    }
    h += '</div>';
  }else{
    const ks = PICK_TREE.get(PICK.job).get(PICK.grp);
    h = '<div class="pk-list">';
    for(const k of ks){
      const p = PRESETS[k];
      const main = typeof p.rate === 'number' ? `<span class="pk-rate">約${p.rate}%</span>` : '<span class="pk-rate pending">検証中</span>';
      const ref = typeof p.greedy === 'number' ? `<span class="pk-ref">簡易 ${Math.round(p.greedy / 5) * 5}%</span>` : '';
      h += `<button class="pk-item${k === G.preset ? ' cur' : ''}" data-key="${esc(k)}">`
         + `<span class="pk-name">${esc(p.name)}</span><span class="pk-rates">${main}${ref}</span><span class="pk-lv">Lv${p.craft}</span></button>`;
    }
    h += '</div>';
    // 見方は1行にまとめる(「検証中」はそのままで分かるので説明しない)
    const notes = [];
    if(ks.some(k => typeof PRESETS[k].rate === 'number')) notes.push('約◯%=大成功率の目安');
    if(ks.some(k => typeof PRESETS[k].greedy === 'number')) notes.push('簡易=先読みなしの参考値');
    if(notes.length) h += `<div class="pk-note">${notes.join(' / ')}(Lv80・光★3)</div>`;
  }
  document.getElementById('pkBody').innerHTML = h;
}
document.getElementById('pickModal').addEventListener('click', e => {
  const b = e.target.closest('button');
  if(!b || b.classList.contains('pad-close')) return;
  const d = b.dataset;
  if('nav' in d){ PICK = { job: d.nav === 'job' ? PICK.job : null, grp: null }; renderPicker(); }
  else if('job' in d){ PICK = { job: d.job, grp: null }; renderPicker(); }
  else if('grp' in d){ PICK.grp = d.grp; renderPicker(); }
  else if('key' in d){
    closePicker();
    if(d.key !== G.preset) onPresetChange(d.key);   // 今と同じ商材を選んだ時は何もしない
  }
});
['s-level','s-hammer','s-star','s-trait'].forEach(id=>{
  document.getElementById(id).addEventListener('change', applySettings);
});

if(!load()) resetAll();
GameLog.restore();

/* ====== 結果の選択(記録用) ====== */
let OUTCOME_NEXT = null;
// 必殺の状態。欄を押すと選ぶ画面を開き、どの状態にも合わせられる
// (チャージが来た時のほか、ゲームで使ったのにアプリで「使った」を押さなかった時や、押し間違えた時のため)。
// 状態の名前と hsKey は、画面の表示(renderHeader)より前に置いてある
function openHS(){
  const k = hsKey();
  document.querySelectorAll('#hsModal .hs-opt').forEach(b => b.classList.toggle('cur', b.dataset.hs === k));
  document.getElementById('hsModal').classList.add('show');
}
function closeHS(){ document.getElementById('hsModal').classList.remove('show'); }
function setHS(k){
  closeHS();
  const st = HS_STATES[k];
  if(!st || k === hsKey()) return;
  G.hs = st[0]; G.hsUsed = st[1];
  GameLog.ev('hs', { state: G.hs, used: G.hsUsed });
  G.rec = null; G.plan = []; G.msg = null;
  renderAll(); save();
  // 計算中なら、その計算が終わった所で計算し直す(doCalc の CALC_AGAIN)
  if(!G.pending.length) doCalc();
}
function askOutcome(next){ OUTCOME_NEXT = next; document.getElementById('outcomeModal').classList.add('show'); }
function closeOutcome(){ OUTCOME_NEXT = null; document.getElementById('outcomeModal').classList.remove('show'); }
function chooseOutcome(o){
  const next = OUTCOME_NEXT; closeOutcome();
  GameLog.finish(o);                 // 端末に貯めて送信は裏で行うので、すぐにリセットへ進む
  if(next) next();
}
renderAll();

// 設定欄の一番下に、届いている版を出す。画面(ui.js)と見た目(style.css)の版が違えば、
// ブラウザが古いファイルを使っているので、その旨を出す。
(function(){
  const el = document.getElementById('v-ver');
  if(!el) return;
  const me = document.querySelector('script[src^="ui.js"]');
  const js = me ? ((me.getAttribute('src').split('?v=')[1]) || '—') : '—';
  const css = getComputedStyle(document.documentElement).getPropertyValue('--css-ver').trim().replace(/"/g, '') || '—';
  const title = (document.title.match(/V[\d.]+/) || [''])[0];
  el.innerHTML = `${title} ・ 画面 ${js} ・ 見た目 ${css}`
    + (js !== css ? '<br><b>見た目のファイルが古いままです。ブラウザのキャッシュを消してください</b>' : '');
})();

// スマホでは下部の操作パネルが画面に固定されている。パネルの高さは状況で変わるので、
// その分だけページ下に余白を取り、設定などの最後の項目がパネルの裏に隠れないようにする。
(function(){
  const foot = document.getElementById('footPanel');
  const mq = window.matchMedia('(max-width: 759px)');
  const sync = () => { document.body.style.paddingBottom = mq.matches ? (foot.offsetHeight + 12) + 'px' : ''; };
  if(typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(foot);
  window.addEventListener('resize', sync);
  sync();
})();

