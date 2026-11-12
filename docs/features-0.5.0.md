# Integração 0.5.0-alpha

Esta versão acrescenta APIs opcionais para projetos maiores e integração com editores. As ideias foram avaliadas no NeoLeaf e implementadas independentemente nesta biblioteca. O NeoLeaf não foi alterado. O contrato básico de `createEngine` e `latexmk` permanece compatível. Os motores continuam TeX Live 2026 e o perfil TDS continua TeX Live 2023 fixado; estes recursos não mudam a versão dos formatos.

## Análise antes de compilar

```ts
import { analyzeProject, detectFontFamilies } from '@typeward/texlive-wasm';
const analysis = analyzeProject(files, 'main.tex');
console.log(analysis.used, analysis.unused, analysis.packages, analysis.tools);
console.log(analysis.problems); // arquivo, linha, severidade e código
console.log(detectFontFamilies(files));
```

Reconhece inclusões literais, caminhos relativos, imagens, classes/pacotes locais e bibliografia. Ignora comentários, verbatim e comandos inline verb. Referências/citações ausentes são avisos conservadores: macros podem gerar nomes dinamicamente. Não é um interpretador TeX. `latexmk({preflight:true,...})` rejeita erros de arquivos do projeto antes da execução; ferramentas externas usam o contrato `tools` existente.

## Fontes exatas e downloads opcionais

A release oferece `font-packs.json` e sete packs `texmf-font-<família>.tar.gz`: PSNFSS, Libertine, NewTX, Inconsolata, Montserrat, Noto Sans e TeX Gyre. Cada catálogo contém tamanho, SHA-256 e mapas autênticos. O catálogo e o índice opcional devem ser obtidos da mesma release, conferindo os respectivos hashes de `checksums.json` por um canal confiável.

```ts
import { createCompileSession } from '@typeward/texlive-wasm';
const session = createCompileSession({
  resourceVersion: '0.5.0-alpha:my-resources-v1',
  config: id => engineConfig(id),
  fontCatalog: { catalog, baseUrl: 'https://my-app.example/texlive/' },
});
const result = await session.compile({engine:'pdflatex', mainTex:'main.tex', files, strict:true});
await session.dispose();
```

A sessão detecta famílias e carrega os packs necessários, incluindo nos helpers de conversão. Trocar de família reinicializa os workers. Não cria aliases nem troca uma fonte por outra. Noto cobre Sans neste perfil; outras variantes exigem recursos adicionais. `selectFontPacks` retorna também famílias não encontradas; aplicativos podem apresentar esse resultado antes de compilar. A detecção não garante suporte a toda variante ou combinação de pacotes. No LuaTeX deste perfil, prefira o nome exato do arquivo, por exemplo `\\setmainfont{texgyretermes-regular.otf}`: a descoberta automática por nome de família não está completa. XeTeX também é testado por nome de família.

Os arquivos de origem são baixados do TeX Live 2023 histórico, com índice fixado por SHA-512 e verificação de cada arquivo. `npm run fonts:build` reproduz os packs, incluindo proveniência e avisos disponíveis. A versão do SDK e a identidade do perfil TDS são campos distintos. Licenças de fontes/pacotes continuam próprias, não MIT por herança do wrapper.

CLI: solicite explicitamente `--assets font-packs.json,texmf-font-inconsolata`. Os packs e o índice de pacotes não entram no download padrão. O CLI preserva packs compactados para `resourcePacks`.

## Pacotes sob demanda

```ts
import { loadPackageIndex, createHttpPackageFs } from '@typeward/texlive-wasm';
const index = await loadPackageIndex(indexUrl, trustedIndexSha256);
const packages = createHttpPackageFs({
  index, version:'tl2023-final',
  baseUrl:'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2023/tlnet-final/',
  maxBytes:128*1024*1024, maxResidentBytes:128*1024*1024,
  cache: {get: async key => loadLocal(key), put: async (key, bytes) => saveLocal(key, bytes)},
});
const config = {bundleUrl:coreUrl, enginePath:wasmUrl, vfs:[packages]};
```

O índice `texlive-package-index.json` é opcional e tem aproximadamente 16 MiB. O provedor verifica arquivos comprimidos por SHA-512, dependências, caminhos e limites; o cache é verificado novamente. `createPackageFs` aceita transportes próprios e TAR/gzip/XZ. O decodificador XZ é carregado apenas quando necessário, usando [xz-decompress](https://github.com/httptoolkit/xz-decompress), MIT. Os pedidos contêm nomes públicos de pacotes, sem fontes do documento. CORS e disponibilidade do espelho dependem da hospedagem; para offline, disponibilize os arquivos/cache antecipadamente. Não há execução automática de scripts baixados. Pacotes que exigem shell escape continuam dependendo de ferramentas explícitas do aplicativo.

## Progresso, prévia e compilação parcial

```ts
await session.warmup({engine:'pdflatex', files});
const result = await session.compile({
  engine:'pdflatex', mainTex:'main.tex', files,
  preview:true,
  onEvent(event) {
    updateProgress(event.type, event.elapsedMs);
    if(event.type==='preview' && event.pdf) showPreview(event.pdf);
  },
  includeOnly:['chapters/introduction'],
});
console.log(result.partial, result.complete, result.totalMs, result.timings);
```

`includeOnly` aplica a semântica TeX de `\\includeonly`: não filtra `\\input`. Um resultado parcial pode ter `success:true`, mas sempre tem `partial:true` e `complete:false`. Não o publique como PDF completo. Seus auxiliares não substituem o cache completo. O aquecimento respeita save-data e dispositivos com até 2 GiB informados pelo navegador; `force:true` permite aquecimento explícito. Eventos são observadores síncronos; mantenha callbacks rápidos. Prévia é opt-in e pode aumentar trabalho, especialmente na conversão XeTeX. `totalMs` inclui preparação, sem tempo de espera na fila.

## Transporte e navegação

Workers recebem um manifesto completo de arquivos e apenas blobs SHA-256 ainda não reconhecidos. Isso preserva exclusões e detecta alterações em buffers mutáveis. O cache por worker é LRU, 64 MiB por padrão; `projectCacheBytes:0` desativa o recurso. Isso reduz cópias de entrada, não elimina passes TeX. Cada execução continua isolada. Os contadores `RunResult.inputTransport` permitem medir bytes enviados/reutilizados.

```ts
import { refineSynctex } from '@typeward/texlive-wasm';
const source = refineSynctex(files, clickedPhrase, {
  preferred: geometricReverseHit, mainTex:'main.tex', focus:clickedWordIndex,
});
```

O refinamento preserva a geometria quando há ambiguidade, normaliza acentos/ligaturas e encontra a palavra selecionada mesmo numa frase dividida entre linhas. O viewer continua fornecendo frase e posição do clique; o parser SyncTeX mantém as coordenadas do PDF.

## Validação de templates

`npm run smoke:corpus` compila fixtures originais de artigo/BibTeX, relatório com capítulos e Beamer. Confere sucesso estrito, texto esperado, páginas e fontes incorporadas. Para testar seus templates sem redistribuí-los:

```json
[{"id":"my-template","root":"/absolute/project","main":"main.tex","engine":"pdflatex","pages":3,"text":["Expected title"]}]
```

Execute `node scripts/smoke-corpus.mjs /path/corpus.json`. O campo opcional `referencePdf` compara as caixas do texto e todos os pixels renderizados a 144 dpi com um PDF de referência local. Apenas leia projetos confiáveis e respeite suas licenças. A comparação nativa de fidelidade e os testes multilíngues permanecem em `scripts/smoke-quality.mjs`. Nenhum corpus finito garante equivalência para todo documento TeX: valide os PDFs representativos de sua aplicação antes de adotar a versão alpha.

## Atualização

Vale atualizar para projetos com fontes opcionais, muitos arquivos ou integração de editor. Usar apenas `latexmk` mantém o fluxo conhecido; configure uma sessão para reutilização entre edições e ative fontes/pacotes conscientemente. Atualize SDK, workers, manifests e assets juntos. A release GitHub inclui o tarball npm; esta entrega não implica publicação no registro npm.
