# Revisão de desempenho, fidelidade e cobertura funcional

Data: 2026-11-12. Base analisada: `903eb8a` / `0.3.1-alpha`.

## Conclusão

Há oportunidades reais de acelerar o sistema, mas a prioridade é detectar PDFs incompletos: hoje a compilação pode informar sucesso mesmo quando faltam caracteres, índices ou glossários. O motor consegue produzir o mesmo PDF que o nativo quando entradas, formatos, pacotes e fontes são equivalentes. Não foi demonstrada equivalência para todo documento nem para os três motores.

Esta revisão não modifica o runtime nem publica uma nova versão. As propostas abaixo precisam de implementação e regressões próprias; os ganhos medidos não devem ser atribuídos a uma versão futura ainda inexistente.

## Método e limites

- Linux x86_64, Node 20.18.0, motores Emscripten já construídos em Docker; execução dos WASM pelo wrapper público em Node.
- Arquivos locais, sem latência de rede. Os tempos de inicialização incluem leitura/descompactação do bundle e preparação do worker, mas não representam download frio de uma aplicação.
- Documento de desempenho: article + amsmath, 30 parágrafos com oito repetições de texto e uma equação. Três compilações por configuração, duas passagens por compilação, reaproveitando o handle TeX. Ordem fixa, sem aleatorização; caches de SO/V8 podem beneficiar casos posteriores.
- Instrumentação externa ao runtime mede criação do módulo, preparação do FS e `callMain`. Pode introduzir pequeno overhead. Três amostras são exploratórias, não um benchmark estatístico ou garantia para Android/iOS.
- Resultados brutos: [benchmark.json](benchmark.json), [capabilities.json](capabilities.json). Reprodutores: [measure.mjs](measure.mjs), [capabilities.mjs](capabilities.mjs).

## Desempenho medido

Tempos em milissegundos, arredondados. Inicialização é separada da compilação; a mediana considera as três amostras, incluindo a primeira compilação.

| Configuração | Inicialização | Compilações | Mediana |
|---|---:|---|---:|
| pdfLaTeX core, TDS lazy | 495 | 570 / 360 / 346 | 360 |
| pdfLaTeX core, TDS eager | 392 | 522 / 399 / 436 | 436 |
| pdfLaTeX full, TDS lazy | 1767 | 864 / 745 / 761 | 761 |
| XeLaTeX core, conversor novo por compilação | 459 | 1636 / 1594 / 1547 | 1594 |
| XeLaTeX core, conversor reutilizado | 848¹ | 1501 / 1171 / 1167 | 1171 |
| LuaLaTeX core | 497 | 1778 / 1559 / 1489 | 1559 |

¹ Inclui inicializar os dois handles. Reutilizar `xdvipdfmx` reduziu aproximadamente 27% da mediana de compilação neste documento; não elimina seu custo inicial.

Na terceira compilação, preparar o FS do pdfLaTeX consumiu aproximadamente 18 ms por passagem com core lazy e 143–147 ms com full lazy. A execução de TeX consumiu aproximadamente 153 ms/passagem no primeiro caso. Em LuaLaTeX, `callMain` consumiu 715–727 ms/passagem e o preparo do FS cerca de 20 ms. Portanto, otimizar apenas o wrapper ou portar sua lógica para Rust não elimina o custo dominante dos motores mais pesados.

### Melhorias propostas

1. **Reutilizar handles e o conversor do XeLaTeX.** Já é possível com a API atual. Evitar criar/destruir todos os workers a cada edição. Testar descarte, timeout e recuperação de falhas; respeitar limites de memória em celular.
2. **Perfis menores de bundle.** Preferir core + recursos necessários à aplicação; carregar full quando necessário. No pdfLaTeX core há 12,73 MiB de Type1, 4,92 MiB de TFM e dois formatos de aproximadamente 6,51 MiB cada. Medir remoções por perfil e provar cobertura antes de reduzir fontes/mapas.
3. **Cache do plano de montagem e `ls-R`.** Atualmente a instância Emscripten é recriada e todos os nós TDS são preparados por passagem, mesmo com leitura lazy. Evitar recomputar caminhos/índices invariantes. A instância fresca protege contra estado global não reentrante: não substituir por reutilização cega de `callMain`.
4. **Sessão incremental entre edições.** Preservar auxiliares e resultados de ferramentas, com chave envolvendo fontes do projeto, opções, motor, TDS, fontes tipográficas e dependências. Invalidar corretamente arquivos removidos. Hoje a estabilização beneficia passagens da mesma compilação, não constitui um cache persistente completo entre edições.
5. **Inicialização concorrente.** Avaliar sobreposição de download/compilação WASM, bundle, ICU e manifesto; deduplicar leituras e requisições. Medir rede lenta e pico de memória, além do tempo total.
6. **Fontconfig e resolução de arquivos.** O cache persistido cobre `/tmp/texmf-var`, mas não `/tmp/fontcache`. Medir documentos fontspec antes de persistir este último. Para faltas TDS, deduplicar tentativas e antecipar dependências conhecidas evita recompilar o documento inteiro para cada descoberta.
7. **Compilação C/C++ orientada a velocidade.** O padrão é `-Oz`. Comparar `-O2`/`-O3` por motor com os mesmos documentos, tamanho transferido e memória. Não há ganho medido dessa troca nesta revisão. A documentação do [Emscripten](https://emscripten.org/docs/optimizing/Optimizing-Code.html) distingue otimização de tamanho e velocidade.

Não recomendar threads como solução padrão: a distribuição visa WebViews móveis sem garantia de `crossOriginIsolated`. Também não reduzir duas passagens para uma indiscriminadamente: referências precisam convergir.

## Fidelidade do PDF

### Comparação positiva controlada

Foi construído um formato nativo com o pdfTeX TL2026 do próprio checkout, dentro do Docker, sobre o mesmo TDS usado pelo WASM. Documento de duas páginas com geometry, amsmath, hyperref, acentos, tabela, equação, referência cruzada e link. Fonte do documento: [fidelity.tex](fidelity.tex). Metadados variáveis foram suprimidos com `\pdfinfoomitdate=1`, `\pdftrailerid{}` e `\pdfsuppressptexinfo=15`.

- PDF nativo e WASM: **52.324 bytes**, SHA-256 idêntico `20319d511ca5b404001435144b7f3ae93238f212b8bcb616c090502fe91c1405`.
- Texto e posições extraídos com `pdftotext -bbox`: idênticos.
- Duas páginas rasterizadas pelo mesmo Poppler a 144 dpi: 1224 × 1584 pixels por página, nenhuma diferença RGB.

Isso comprova equivalência deste caso, não de qualquer instalação TeX Live. Um corpus permanente deve incluir tabelas extensas, quebras de página, imagens, transparência, microtype, fontes externas, Unicode/RTL, TikZ, bibliografias e PDFs de referência para cada motor. Comparar texto/posições, fontes incorporadas, páginas e pixels; hashes binários só quando metadados forem controlados.

### Inconsistências e falhas confirmadas

| Caso real | Resultado atual | Consequência |
|---|---|---|
| LuaLaTeX com `Hello 中文 😀`, fonte padrão | `success: true`, log com `Missing character` | Caracteres solicitados não aparecem; sucesso de processo não garante conteúdo completo |
| imakeidx com índice nomeado `people` | `success: true`, `No file people.ind` | Índice não é gerado automaticamente |
| glossaries com `\makeglossaries` | `success: true`, `No file main.gls` | Glossário solicitado não aparece |
| `babel[brazil]`, bundle full local | Falha: opção desconhecida | Português não está disponível neste bundle |
| classe `abntex2`, bundle full local | Falha: classe não encontrada | Documento ABNT não compila neste bundle |
| TikZ básico, bundle full | Sucesso | TikZ já funciona; não deve ser listado como ausente em geral |
| execução explícita `--fmt=latex` | Formato de versão incompatível | `latex.fmt` distribuído não funciona com o executável atual |

Os probes não configuram CDN adicional. Não significam que um consumidor não possa fornecer pacotes ou fontes por backend próprio. Em particular, suporte a Unicode no motor não implica que a fonte escolhida cubra todos os caracteres.

### Prioridades para correção

- **Diagnósticos estruturados e política de rigor configurável:** separar PDF produzido de documento completo; expor glifos ausentes, substituição de fontes e ferramentas pendentes. Preservar compatibilidade do retorno existente e permitir falhar em modo estrito. Não converter todo warning de layout em erro.
- **Convergência completa:** acompanhar `.toc`, `.out`, `.nav`, auxiliares de capítulos e saídas das ferramentas, além do auxiliar principal e mensagens de rerun; detectar ciclos e explicar limite de passagens.
- **Ambiente tipográfico versionado:** motores são TL2026, enquanto os pacotes do TDS vêm das versões Ubuntu/TL2023 fixadas no lock. Isso não prova que os PDFs estejam errados, mas impede prometer igualdade com uma instalação TL2026 atual. Oferecer perfis coerentes e imutáveis, sem atualizar pacotes/fontes silenciosamente. Atualizar biblatex exige atualizar Biber em conjunto.
- **Formatos coerentes:** `build-fmt.mjs` regenera pdflatex.fmt, mas o latex.fmt legado permanece no pacote. Regenerar com semântica correta ou remover do perfil/contrato que não o suporta. Não são arquivos byte a byte duplicados, apesar do tamanho semelhante.
- **Datas reproduzíveis:** `RunOptions.env` é traduzido em configurações `-cnf-line`, não em variáveis reais de processo. O código nativo lê `SOURCE_DATE_EPOCH`/`FORCE_SOURCE_DATE` com `getenv`. Validar e implementar esse contrato antes de anunciar reprodução por essas opções. Alterar `\today` exige escolha explícita. Ver [manual do pdfTeX](https://tug.ctan.org/systems/doc/pdftex/manual/pdftex-a.pdf).

## Recursos a ampliar

| Prioridade | Recurso | Escopo necessário |
|---|---|---|
| Alta | Português/ABNT | Pack opcional com babel-portuges, hifenização, abntex2, estilos e dependências; testes de acentos, citações e sumário |
| Alta | Índices nomeados e glossários | Descoberta de todos os trabalhos, chamada de makeindex e múltiplas saídas; testes de ordenação e convergência |
| Alta | Fontes e idiomas | Packs opcionais CJK/árabe/RTL, fontes licenciadas e shaping; fontes de emoji conforme suporte real de cada motor |
| Média | Estilos bibliográficos adicionais | O fetch atual cura uma lista de estilos e remove outros; publicar packs com manifesto e hashes, mantendo a versão Biber/biblatex pareada |
| Média | SVG/EPS e código com realce | Conversores/broker explícito de ferramentas para recursos que dependem de programas externos; minted não se resolve só adicionando o `.sty` |
| Média | PDF/A, PDF/UA e PDF marcado | Perfil de pacotes atualizado, fontes adequadas e validação externa; não prometer conformidade só por produzir um PDF |

Arquivos apenas rebaixados de core para CDN são diferentes de arquivos removidos fisicamente por `fetch-tds.sh`. Um fallback com manifesto estrito não recupera automaticamente um arquivo que não existe no índice publicado. Packs devem declarar suas dependências e integridade.

## Ordem sugerida de implementação e aceite

1. Adicionar corpus de referência e testes dos seis casos problemáticos antes de alterar comportamento.
2. Corrigir diagnósticos de conteúdo e formatos incompatíveis; entregar pack português/ABNT sem inflar o core de todos os usuários.
3. Completar orquestração de índices/glossários e convergência; verificar que o texto esperado aparece no PDF.
4. Otimizar montagem do FS, inicialização e cache incremental, repetindo o benchmark e a comparação visual após cada mudança.
5. Avaliar flags de compilação e novos perfis/fontes em navegadores e aparelhos reais, com memória máxima e tempo até o primeiro PDF como critérios.

Regressões mínimas: retorno público compatível; documentos de referência sem perda de texto/páginas; índices/glossários efetivamente presentes; recuperação após erro; nenhuma saída antiga reutilizada com fonte/configuração alterada; testes de integridade para novos packs. Evitar metas percentuais arbitrárias antes de estabelecer uma medição móvel repetível.

## Reprodução

Com `npm run build` e os artefatos locais desta revisão disponíveis:

```sh
node docs/analysis/2026-11-12/measure.mjs
node docs/analysis/2026-11-12/capabilities.mjs
```

`measure.mjs` escreve em `/tmp/texlive-review-reproduction`, ou no diretório indicado por `REVIEW_OUTPUT`. `capabilities.mjs` imprime os resultados e, se `REVIEW_OUTPUT` estiver definido e existir, grava seu JSON ali. Os testes de capacidades documentam limitações atuais, não são asserts de conformidade.

Verificação desta revisão: suíte TypeScript **175/175**, benchmark real de **18 compilações**, seis probes de capacidades e um probe de formato; comparação nativa/WASM descrita acima. Nenhuma alteração nos motores ou na API foi feita.

## Pontos de implementação revisados

- `src/core/worker.ts`: inicialização, criação de FS por instância, persistência de caches e tradução de opções para kpathsea.
- `src/latexmk/index.ts`: convergência, estado auxiliar e orquestração de ferramentas.
- `scripts/fetch-tds.sh`, `scripts/data/tds-packages.lock`, `scripts/data/core-tier.list`: origem, seleção e empacotamento do TDS.
- `scripts/build-fmt.mjs`: formatos regenerados pelo motor WASM.
- `engine/targets/common.mk`: nível de otimização do build.

Para repetir a referência nativa, gerar um formato **nativo** com o pdfTeX do checkout (`-ini -etex -progname=pdflatex -jobname=pdflatex`, entrada `tex/latex/tex-ini-files/pdflatex.ini`), montando o TDS local em `/texmf-dist` dentro do Docker. Compilar `fidelity.tex` até estabilizar com esse formato e os caminhos kpathsea equivalentes ao worker. Não carregar o formato WASM no executável nativo. Comparar com a saída do mesmo arquivo via `latexmk` público e bundle full. Datas/IDs precisam continuar suprimidos como no fixture para comparar SHA-256.
