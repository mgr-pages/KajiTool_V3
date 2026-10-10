/* =====================================================================
   対局の記録の「会心の集計」(tools/log-collector.gs の doGet が返す JSON)から、
   エンジンの会心率の式の上乗せを推定する。

   使い方:
     curl -sL '<送り先の URL(gamelog.js の GLOG_ENDPOINT)>' | node tools/crit-report.js
     node tools/crit-report.js 集計.json
     node tools/crit-report.js 集計.json 光★3      装備を1つに絞る(省くと装備ごとに分けて全部出す)

   数えるのは、会心かどうかを値で区別できる打撃だけ(log-collector.gs が、どちらとも取れる値と古い版の記録を除いて数える)。
   装備(ハンマー・できのよさ・職人Lv)ごとに分けて推定する。ハンマーとできのよさで基礎の会心率が変わるので、
   混ぜると、ずれがハンマーの会心率の値から来たのか、上乗せから来たのかを見分けられない。

   推定のしかた:
     ・打撃ごとに「基礎の会心率」(上乗せの無い会心率。職人Lv・ハンマー・できのよさで決まる)を足し合わせ、
       会心の回数をその合計で割ったものを「基礎に対する倍率」とする。エンジンの式では
         ふつうの技 1倍 / ねらい系 7倍(+600%) / 集中力変化の会心ターン 5倍(+400%) / 会心ターン×ねらい系 11倍 /
         威力会心率上昇の点灯マス 5倍(+400%、利用者の情報) / 点灯マス×ねらい系 11倍
     ・上乗せは、同じ記録の「ふつうの状況・ねらい系でない技」の倍率との比で求める
       (基礎の会心率の仮定がずれていても、比では打ち消し合う)。
     ・95%の範囲は、会心の回数をポアソン分布とみなした比の対数の誤差(1/会心の回数 の和)から求める。
   ===================================================================== */
'use strict';
const fs = require('fs');
const fileArg = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null, only = process.argv[3] || null;
const src = fileArg ? fs.readFileSync(fileArg, 'utf8') : fs.readFileSync(0, 'utf8');
const S = JSON.parse(src);
const ALL = S.groups || [];
const TR = { kaishin: '威力会心率上昇', shuchu: '集中力変化', tataki: 'たたき変化', modori: 'メーター減少・戻り' };
const f1 = v => (100 * v).toFixed(1) + '%', f2 = v => v.toFixed(2);

console.log(`集計した対局 ${S.records}(${Object.entries(S.recordsByTrait || {}).map(([k, v]) => (TR[k] || k) + ' ' + v).join(' / ')})  打撃 ${S.hits}  作った日時 ${S.generated}`);
// 装備ごとに分ける(装備の無い古い集計は1つにまとめる)
const eqOf = g => g.equip || '(装備の記録なし)';
const equips = [...new Set(ALL.map(eqOf))].filter(e => !only || e === only);
if(only && !equips.length) console.log(`装備「${only}」の記録はありません。ある装備: ${[...new Set(ALL.map(eqOf))].join(' / ')}`);
for(const eq of equips) report(eq, ALL.filter(g => eqOf(g) === eq));

function report(eq, G){
  const recs = S.recordsByEquip ? S.recordsByEquip[eq] : S.records;
  console.log('');
  console.log(`==== 装備 ${eq}(対局 ${recs === undefined ? '—' : recs}${G[0] && G[0].base !== undefined ? '、基礎の会心率 ' + f1(G[0].base) : ''}) ====`);
  console.log('地金特性        状況        技        叩いた 会心  会心率(実測 / 見込み)  基礎に対する倍率(実測 / エンジン)  見込みとの差');
  for(const g of G.filter(x => x.n > 0)){
    // 見込みとの差: z = (会心の回数 − 見込みの合計) ÷ √(見込み×(1−見込み) の合計)。古い集計(sumVar が無い)は出さない
    const z = g.sumVar > 0 ? (g.crit - g.sumCr) / Math.sqrt(g.sumVar) : null;
    const zs = z === null ? '' : `z=${z.toFixed(2)}${g.n < 30 ? '(少ない)' : Math.abs(z) < 2 ? '(誤差の範囲)' : '(ずれ)'}`;
    console.log(`${(TR[g.trait] || g.trait).padEnd(10, '　')} ${g.sit.padEnd(5, '　')} ${g.cls.padEnd(4, '　')} ${String(g.n).padStart(6)} ${String(g.crit).padStart(5)}  ${f1(g.crit / g.n).padStart(6)} / ${f1(g.sumCr / g.n).padStart(6)}      ${f2(g.crit / g.sumBase).padStart(6)} / ${f2(g.sumCr / g.sumBase).padStart(5)}        ${zs}`);
  }

  // 倍率(基礎に対する)と、比の95%の範囲
  const pick = (pred) => { const a = G.filter(pred); return a.length ? { n: a.reduce((s, g) => s + g.n, 0), crit: a.reduce((s, g) => s + g.crit, 0),
    sumBase: a.reduce((s, g) => s + g.sumBase, 0), sumCr: a.reduce((s, g) => s + g.sumCr, 0) } : null; };
  function ratio(num, den, model, label){
    if(!num || !den || !num.crit || !den.crit){ console.log(`${label}: まだ数えられない(会心の回数が0)`); return; }
    const r = (num.crit / num.sumBase) / (den.crit / den.sumBase);
    const se = Math.sqrt(1 / num.crit + 1 / den.crit);
    const lo = r * Math.exp(-1.96 * se), hi = r * Math.exp(1.96 * se);
    const pc = x => (x - 1 >= 0 ? '+' : '') + Math.round(100 * (x - 1)) + '%';
    console.log(`${label}: ${f2(r)}倍(上乗せ ${pc(r)}、95%の範囲 ${pc(lo)}〜${pc(hi)})  エンジン ${f2(model)}倍(${pc(model)})  数えた打撃 ${num.n}(会心 ${num.crit})`);
  }
  // 比べる相手: ふつうの状況・ねらい系でない技(全地金特性。基礎の会心率だけで決まる打撃)
  const plain = pick(g => g.sit === 'ふつう' && g.cls === 'それ以外');
  const plainAim = pick(g => g.sit === 'ふつう' && g.cls === 'ねらい系');
  console.log('');
  if(plain) console.log(`基準(ふつうの状況・ねらい系でない技): 打撃 ${plain.n} 会心 ${plain.crit}  基礎に対する倍率 ${f2(plain.crit / plain.sumBase)}(エンジン 1.00。ずれていれば基礎の会心率の仮定がずれている)`);
  ratio(pick(g => g.sit === '点灯' && g.cls === 'それ以外'), plain, 5, '点灯マス × ねらい系でない技');
  ratio(pick(g => g.sit === '点灯' && g.cls === 'ねらい系'), plain, 11, '点灯マス × ねらい系');
  ratio(plainAim, plain, 7, 'ねらい系(ふつうの状況)');
  ratio(pick(g => g.sit === '会心ターン' && g.cls === 'それ以外'), plain, 5, '会心ターン × ねらい系でない技');
  ratio(pick(g => g.sit === '会心ターン' && g.cls === 'ねらい系'), plain, 11, '会心ターン × ねらい系');
  // 点灯マスの上乗せを、点灯 × ねらい系 と ねらい系だけ の比でも見る(ねらい系の上乗せと足し算で重なるかの確かめ)
  ratio(pick(g => g.sit === '点灯' && g.cls === 'ねらい系'), plainAim, 11 / 7, '点灯マス × ねらい系 ÷ ねらい系(ふつう)');
  // 点灯マスの上乗せを、基礎の会心率の式を信じて(比べる相手を使わずに)求める。比べる相手の誤差が入らない分、範囲が狭い
  const lit = pick(g => g.sit === '点灯' && g.cls === 'それ以外');
  if(lit && lit.crit){
    const r = lit.crit / lit.sumBase, se = Math.sqrt(1 / lit.crit);
    console.log(`点灯マス × ねらい系でない技(基礎の会心率の式を信じた場合): ${f2(r)}倍(95%の範囲 ${f2(r * Math.exp(-1.96 * se))}〜${f2(r * Math.exp(1.96 * se))}倍)`);
  }
  // 必要な量の目安: 倍率の95%の範囲を ±h 倍にするのに要る、点灯マスでの会心の回数(基礎の式を信じた場合)は (1.96×倍率/h)^2。
  // 点灯マスをねらい系でない技で叩くのは、威力会心率上昇の商材で1局あたり約4回(エンジンで数えた値)
  console.log('');
  const R = lit && lit.crit ? lit.crit / lit.sumBase : 5, pLit = lit && lit.n ? lit.crit / lit.n : 0.31;
  for(const h of [1, 0.5]){
    const need = Math.ceil(Math.pow(1.96 * R / h, 2) / pLit);
    console.log(`95%の範囲を ±${h}倍(±${h * 100}%)にするには、点灯マスをねらい系でない技で叩いた記録が約${need}回(威力会心率上昇の商材で約${Math.ceil(need / 4)}局。比べる相手との比で見るなら、その2倍ほど)。今 ${lit ? lit.n : 0}回`);
  }
}
