import {createEngine,latexmk} from '../../../dist/index.js';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
import {writeFile} from 'node:fs/promises';
const root=repo+'/engine-artifacts';
const rows=[];
const pdf=await createEngine('pdflatex',{enginePath:root+'/pdflatex/emscripten/pdflatex.wasm',bundleUrl:root+'/texmf.tar.gz'});
const lua=await createEngine('lualatex',{enginePath:root+'/lualatex/emscripten/lualatex.wasm',bundleUrl:root+'/texmf-core-lualatex.tar.gz'});
for(const [name,engine,body] of [
 ['portuguese','pdflatex',String.raw`\documentclass{article}\usepackage[brazil]{babel}\begin{document}Português: ação e informação.\end{document}`],
 ['abnt','pdflatex',String.raw`\documentclass{abntex2}\begin{document}Teste ABNT\end{document}`],
 ['tikz-full','pdflatex',String.raw`\documentclass{article}\usepackage{tikz}\begin{document}\begin{tikzpicture}\draw(0,0)circle(1cm);\end{tikzpicture}\end{document}`],
 ['glyphs','lualatex',String.raw`\documentclass{article}\begin{document}Hello 中文 😀\end{document}`],
 ['multiple-index','pdflatex',String.raw`\documentclass{article}\usepackage{imakeidx}\makeindex[name=people,title=People]\begin{document}Alice\index[people]{Alice}\printindex[people]\end{document}`],
 ['glossary','pdflatex',String.raw`\documentclass{article}\usepackage{glossaries}\makeglossaries\newglossaryentry{api}{name=API,description={application interface}}\begin{document}\gls{api}\printglossaries\end{document}`],
]){
 try{const result=await latexmk({engine,mainTex:'main.tex',files:[{path:'main.tex',content:body}],handles:{tex:engine==='pdflatex'?pdf:lua},engineConfig:id=>({enginePath:root+`/${id}/emscripten/${id}.wasm`,bundleUrl:root+'/texmf.tar.gz'}),timeoutMs:60000});
 const warnings=(result.log+'\n'+result.logs.map(l=>l.stdout+'\n'+l.stderr).join('\n')).split('\n').filter(l=>/Missing character|No file .*\.(ind|gls|acr)|Error|Warning|not found|Unknown option/i.test(l));
 rows.push({name,success:result.success,exitCode:result.exitCode,passes:result.passes,commands:result.logs.map(l=>l.cmd),warnings:[...new Set(warnings)].slice(0,12)});
 }catch(e){rows.push({name,error:String(e)});}
}
const fmt=await pdf.run({args:['--fmt=latex','--interaction=nonstopmode','--halt-on-error','main.tex'],files:[{path:'main.tex',content:String.raw`\documentclass{article}\begin{document}Test\end{document}`} ]});
rows.push({name:'latex-format-alias',exitCode:fmt.exitCode,stdout:fmt.stdout.slice(-600)});
await pdf.dispose();await lua.dispose();
console.log(JSON.stringify(rows,null,2));if(process.env.REVIEW_OUTPUT)await writeFile(process.env.REVIEW_OUTPUT+'/capabilities.json',JSON.stringify(rows,null,2));
