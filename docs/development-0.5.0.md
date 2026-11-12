# Plano de desenvolvimento 0.5.0

Objetivo: incorporar os recursos identificados no NeoLeaf como APIs reutilizáveis, sem acoplar a biblioteca ao editor, servidor ou dados de usuários desse projeto.

## Etapas e critérios de aceite

1. Análise prévia pura: reconhecer arquivos alcançáveis, ignorar comentários/verbatim, resolver inclusões, imagens e bibliografia; retornar problemas com arquivo/linha, requisitos de ferramentas e famílias tipográficas. Testes com nomes Unicode, arquivos ausentes, caminhos relativos e falsos comandos em exemplos.
2. Pacotes e fontes: índice TLPDB arquivo/pacote, provedor opcional de pacotes com versões e hashes, cache compartilhado por conteúdo e extração com caminhos TDS preservados. Catálogo de packs por família e detecção no projeto, sem substituir fontes silenciosamente. Testar integridade, conflitos, falhas transitórias e pacotes auxiliares.
3. Navegação: refinamento opcional de respostas SyncTeX por palavras/frases, com normalização de acentos/ligaturas, desempate pelo resultado original e rejeição de correspondências ambíguas. O parser SyncTeX existente permanece a fonte geométrica.
4. Transporte incremental: arquivos por SHA-256 entre host e worker, reutilização de blobs e estado por sessão, aplicação de exclusões e limite de memória. Cada instância TeX continua fresca. Verificar isolamento, recuperação após timeout e hashes do PDF contra transferência completa.
5. Orquestração: eventos de etapas e tempos, prévia intermediária, aquecimento explícito e compilação parcial com includeonly. Resultados parciais identificados e isolados dos auxiliares da compilação completa. Deadlines/cancelamento abrangem todos os passos.
6. Corpus: documentos originais cobrindo artigos, relatórios, slides, referências, fontes e divisão por capítulos; executar motores reais, validar texto/estrutura e preservar a comparação nativa. Templates externos ficam opcionais e exigem licença/proveniência próprias.
7. Integração/documentação: exemplos do catálogo de fontes, resolução de pacotes, eventos, modo parcial e refinamento; atualizar demo quando adequado, validar API ES/CJS e pacote instalado.
8. Entrega: lint, tipos, cobertura sem redução dos gates, testes Rust/navegador, motores reais, corpus e pacote limpo; commit/push, CI e release com versão aumentada.

## Decisões

- Código novo independente; referências conceituais ao NeoLeaf registradas. Nenhuma alteração no NeoLeaf.
- Packs separados, hashes obrigatórios e versões coerentes; nenhum allowUnverifiedAssets automático, concatenação manual de TAR, achatamento de caminhos ou fallback para fontes diferentes.
- Resolver de pacotes aceita provedores explícitos, sem servidor obrigatório nem envio de fontes do usuário para serviços remotos.
- Integrações nativas usam o contrato de ferramentas existente. O daemon, autenticação e pairing do NeoLeaf permanecem no aplicativo; a biblioteca não inicia um serviço localhost.
- Preview/partial não equivalem a PDF completo. Ganhos de desempenho dependem do documento e serão medidos.

## Implementação entregue

- Etapas 1 a 5 implementadas nas APIs públicas e cobertas por regressões unitárias e execução real. A resolução de pacotes inclui decodificação XZ offline, cache verificado e limites de memória.
- Etapa 6: fixtures originais, manifest externo opcional e comparação geométrica/pixel a pixel com referência local. O corpus de referência nativa passou a 144 dpi.
- Etapa 7: guia `docs/features-0.5.0.md`, demo com eventos/prévias e assets opcionais preservados pelo CLI. Os packs têm proveniência, hashes e avisos de licença.
- Etapa 8: validações e entrega registradas em `docs/validation-0.5.0-alpha.md`.

Integrações de autenticação, colaboração, pairing, Git, viewer e daemon nativo continuam responsabilidades do aplicativo consumidor. O plano incorpora os recursos reutilizáveis do NeoLeaf, sem transformar o SDK em um editor ou serviço.
