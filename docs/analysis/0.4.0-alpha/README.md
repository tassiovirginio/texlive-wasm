# Medições da 0.4.0-alpha

Ensaios locais Linux x86_64 / Node 20.18.0, arquivos em disco, builds Emscripten em Docker. Não incluem download frio nem representam um aparelho móvel. Tempos variam com caches, GC e carga; não inferir aceleração universal de poucas amostras.

## Sessão incremental

[session.json](session.json) contém seis revisões comparadas com compilação limpa. A primeira inicializa a sessão; nas cinco edições seguintes:

- Mediana incremental: **207 ms**, uma passagem.
- Mediana limpa com handle já carregado: **376 ms**, duas passagens.
- Redução de tempo neste cenário: **45%**.
- Todos os seis PDFs são idênticos byte a byte entre os dois caminhos.

Reprodução: `node scripts/benchmark-session.mjs /tmp/session.json`. O fixture suprime metadados variáveis. Alterações que afetem auxiliares podem exigir mais passagens; mudanças de recursos invalidam o cache.

## Perfis de bundle e helper

[benchmark.json](benchmark.json) usa o reprodutor da revisão anterior, três compilações por configuração. Valores em ms:

| Configuração | Inicialização | Mediana de compilação |
|---|---:|---:|
| pdfLaTeX core lazy | 394 | 475 |
| pdfLaTeX core eager | 376 | 379 |
| pdfLaTeX full lazy | 1561 | 770 |
| XeLaTeX, conversor recriado | 440 | 1664 |
| XeLaTeX, conversor reutilizado | 778 | 1178 |
| LuaLaTeX core | 581 | 1734 |

A inicialização do XeLaTeX reutilizado inclui os dois workers. Reutilizar o conversor reduziu a mediana em cerca de 29% neste ensaio. A diferença lazy/eager mudou de sinal em relação ao ensaio anterior: não há evidência suficiente para prometer melhor tempo com lazy em todo cenário. Ele permanece padrão para evitar copiar todo o TDS para o heap; a opção eager continua disponível.

Também não houve ganho uniforme nas compilações completas de todos os motores. A redução de passagens da sessão é o benefício mais consistente demonstrado. O custo nativo de TeX ainda domina muitos documentos; flags `-O2`/`-O3` e threads não foram promovidas a padrão sem evidência de benefício em dispositivos reais.

O core pdfLaTeX final mede **21,34 MiB gzip**, contra aproximadamente 27 MiB na revisão anterior, mesmo incluindo suporte adicional de métricas EC/Latin Modern e padrões portugueses. A remoção do formato DVI do core explica a maior parte da redução. O formato DVI corrigido continua no full.

## Fidelidade e conteúdo

A validação real passou para português/ABNT com full e core+pack, idioma português ativo com padrões preloaded, índices nomeados, glossários/siglas, ano reproduzível, CJK/árabe com Noto e rejeição estrita de glifos ausentes. O PDF de referência mantém o SHA-256 nativo `20319d511ca5b404001435144b7f3ae93238f212b8bcb616c090502fe91c1405`.

Isso valida os fixtures declarados, não qualquer documento arbitrário nem conformidade PDF/A/PDF/UA. Detalhes e reprodução em [validação da versão](../../validation-0.4.0-alpha.md).
