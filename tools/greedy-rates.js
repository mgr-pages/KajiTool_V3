#!/usr/bin/env node
/* =====================================================================
   全商材の「先読みをしない打ち方(貪欲)」の大成功率を測り、engine.js の PRESET_GREEDY の表を作る。
   商材の選択欄に「簡易 ◯%」と薄い字で出す参考値(先読みありの目安 PRESET_RATES より目立たせない)。

   使い方(リポジトリの直下で):
     node tools/greedy-rates.js                   測って表を出す(engine.js は書き換えない)
     node tools/greedy-rates.js --write 1         測って engine.js の PRESET_GREEDY を置き換える
     node tools/greedy-rates.js --games 1000 --seed 44 --dir 記録の置き場所 --jobs 4

   ・1商材ごとに tools/analyze.js(乱数テープ・職人Lv80・光のハンマー★3)を子プロセスで打つ。
     記録は --dir に「商材.jsonl」で残り、同じ --dir で再実行すると続きから打つ(済んだ局は飛ばす)。
     推奨手を変えた後は、新しい --dir で測り直すこと(古い記録が混ざらないように)。
   ・1000局の95%の範囲は ±3pt ほど。選択欄では5%刻みに丸めて出す。
   ===================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const o = { games: 1000, seed: 44, dir: path.join(require('os').tmpdir(), 'greedy-rates'), jobs: 4, write: 0 };
const a = process.argv.slice(2);
for(let i = 0; i < a.length; i += 2){ const k = a[i].replace(/^--/, ''); o[k] = k === 'dir' ? a[i + 1] : Number(a[i + 1]); }
fs.mkdirSync(o.dir, { recursive: true });

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8'), { filename: 'engine.js' });
const ORDER = vm.runInThisContext('PRESET_ORDER'), NAMES = vm.runInThisContext('PRESETS');
const logOf = k => path.join(o.dir, k + '.jsonl');

function runOne(k){
  return new Promise(res => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tools/analyze.js'), '--preset', k, '--games', String(o.games), '--tape', '1',
                                       '--seed', String(o.seed), '--log', logOf(k)], { cwd: ROOT, stdio: 'ignore' });
    p.on('close', code => { if(code) console.error(`失敗 ${k}(終了コード ${code})`); res(); });
  });
}
(async () => {
  const queue = ORDER.slice(); let done = 0;
  const worker = async () => { while(queue.length){ const k = queue.shift(); await runOne(k); done++;
    if(done % 10 === 0 || done === ORDER.length) console.error(`済 ${done} / ${ORDER.length}`); } };
  await Promise.all(Array.from({ length: Math.max(1, o.jobs) }, worker));

  const rows = [];
  for(const k of ORDER){
    const recs = fs.existsSync(logOf(k)) ? fs.readFileSync(logOf(k), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const n = recs.filter(r => r.g < o.games).length, g = recs.filter(r => r.g < o.games && r.great).length;
    if(n < o.games) console.error(`局が足りない ${k}: ${n} / ${o.games}`);
    rows.push([k, n ? Math.round(1000 * g / n) / 10 : null]);
  }
  // 1行に5商材ずつ。キーは商材の名前(元の9商材は kagayaki などの短い名前)。名前のまま書けないキーだけ引用符で囲む
  const bare = k => { try{ new Function(`({${k}:1})`); return true; }catch(e){ return false; } };
  const ent = rows.filter(r => r[1] !== null).map(([k, v]) => `${bare(k) ? k : `'${k}'`}:${v}`);
  const lines = []; for(let i = 0; i < ent.length; i += 5) lines.push('  ' + ent.slice(i, i + 5).join(', ') + ',');
  const obj = `const PRESET_GREEDY = {\n${lines.join('\n')}\n};`;
  console.log(obj);
  const vals = rows.filter(r => r[1] !== null).map(r => r[1]);
  console.error(`${vals.length}商材 平均 ${(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1)}%  50%未満 ${vals.filter(v => v < 50).length}商材`);
  if(o.write){
    const f = path.join(ROOT, 'engine.js'), src = fs.readFileSync(f, 'utf8');
    if(!/const PRESET_GREEDY = \{[\s\S]*?\n\};/.test(src)){ console.error('engine.js に PRESET_GREEDY が見つからない'); process.exit(1); }
    fs.writeFileSync(f, src.replace(/const PRESET_GREEDY = \{[\s\S]*?\n\};/, obj));
    console.error('engine.js の PRESET_GREEDY を書き換えた(コメントの版と局数も直すこと)');
  }
})();
