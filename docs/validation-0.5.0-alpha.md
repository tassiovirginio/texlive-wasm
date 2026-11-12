# Validação 0.5.0-alpha

## Evidência local

- 231 testes TypeScript; cobertura de linhas 92,80%, statements 89,98%, branches 82,02% e funções 91,44%. Gates originais preservados.
- 53 testes Rust, integração Node ES/CJS e cancelamento/timeout. O decodificador XZ é exercitado pelo pacote compilado nos dois formatos, além dos testes Vite.
- 25 testes de navegador: Chromium, Firefox, WebKit e perfis móveis. Incluem alterações de buffers, manifesto com exclusões e descompressão XZ.
- Oito pipelines reais: pdfTeX, XeTeX/conversor, LuaTeX, BibTeX, MakeIndex, biblatex/BibTeX, Biber e CSL.
- Nove regressões de conteúdo preservadas: português/ABNT, core mínimo, índices nomeados, glossário/acrônimos, data reproduzível, referência nativa, glyph ausente, shaping multilíngue e formato latex/DVI.
- Corpus original: artigo com BibTeX (3 passes, 1 página), relatório com capítulos/referências (2 passes, 3 páginas), slides Beamer (2 passes, 2 páginas).
- Referência nativa: 2 páginas; texto, caixas de palavras e pixels de todas as páginas idênticos a 144 dpi. O smoke de qualidade também preserva o SHA-256 esperado do PDF de referência.
- Packs reais PSNFSS, Libertine, NewTX, Inconsolata, Montserrat, Noto Sans e TeX Gyre compilados em modo estrito, com fonte esperada incorporada e sem Type 3. Fontes opcionais também verificadas em XeTeX por nome de família e LuaTeX por arquivo OTF exato. Prévia, includeonly, retorno ao PDF completo e navegação SyncTeX verificados.
- Pacote TeX Live real carregado sob demanda com índice fixado, arquivo XZ e SHA-512 verificado. Nenhuma fonte do projeto enviada ao provedor.
- Builds da biblioteca, demo e frontend Tauri; pacote instalado e CLI verificados antes da publicação.

## Medições e limites

No fixture com um arquivo de 1 MiB, a segunda execução enviou **0 bytes** de conteúdo e reutilizou **1.048.649 bytes**. São bytes no transporte host/worker, não uma promessa de redução proporcional do tempo TeX. Hashing, cache e a memória adicional têm custo; desative com `projectCacheBytes:0` se inadequado ao aplicativo.

Downloads opcionais comprimidos por família: PSNFSS 1,83 MiB; Libertine 16,45 MiB; NewTX 7,54 MiB; Inconsolata 0,39 MiB; Montserrat 21,09 MiB; Noto Sans 14,69 MiB; TeX Gyre 8,70 MiB. O usuário baixa apenas as famílias selecionadas. O índice completo de pacotes é um recurso separado, aproximadamente 16 MiB. Esses números não comparam famílias diferentes como equivalentes tipográficos.

A compilação parcial é explicitamente incompleta e seus auxiliares não substituem o cache do documento completo. Prévias podem adicionar custo, especialmente em XeTeX. Não há alteração nos binários C ou no perfil TDS base nesta versão. PDFs de outros documentos devem ser validados com os templates, fontes e dados representativos da aplicação; não se garante equivalência universal a qualquer instalação TeX.

Consulte o [guia de integração](features-0.5.0.md) para atualização e APIs opcionais.
