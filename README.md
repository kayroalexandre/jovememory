# jovememory

Memória persistente para agentes de desenvolvimento: fontes organizadas por workspace, busca híbrida, ativação automática, histórico auditável e retomada de projetos. Implementação nova, com desenvolvimento local e produção no Railway.

O servidor oferece **32 ferramentas MCP** por stdio e Streamable HTTP autenticado. As 28 funções da aplicação anterior foram reconstruídas; quatro ferramentas complementam administração de nós/grafo, indexação e recuperação privada de mídia. Os contratos novos e suas diferenças estão em [PARITY.md](docs/PARITY.md).

## Instalação local

Requisitos: Node.js 22.22 ou superior, npm, Docker Compose; `pg_dump` e `pg_restore` 17 ou superior para backup. A aplicação não exige modelos locais.

```sh
npm ci
npm run local:init
npm run local:up
npm run migrate
npm run cli -- setup-local
npm run cli -- workspace example-project
npm run verify
npm run test:integration
npm start
```

`local:init` gera segredos aleatórios em `.env` e `private/`, com permissões restritas. Não sobrescreve configuração existente. O Compose usa serviços, volumes e portas próprios, vinculados a loopback. A instalação começa **sem conteúdo e sem workspaces**; `example-project` só existe se o operador executar o comando acima.

`GET http://127.0.0.1:3000/health` informa prontidão de banco/schema. O endpoint MCP fica em `/mcp` e exige Bearer token. Tokens de cliente ficam em `private/local-reader.token`, `private/local-writer.token`, `private/local-reviewer.token` e `private/local-admin.token`. Nunca coloque seus valores no repositório, em URL ou em mensagens.

## Fluxo de memória

1. Um perfil `writer` grava conteúdo com `memory_write`, `memory_propose_write`, ingestão, checkpoint ou registro de projeto.
2. Por padrão, a memória é ativada na mesma transação e fica disponível imediatamente, sem aprovação humana. A resposta informa `outcome: accepted`, `item.status: active` e `review_required: false`.
3. `reader` pesquisa candidatos e relê fontes. Resultados incluem workspace, ID, hash, proveniência e limites de verificação.
4. Atualizações e consolidações ativam o sucessor e invalidam as versões anteriores atomicamente, preservando história e auditoria.

`MEMORY_REVIEW_MODE=automatic` é o padrão no local e no Railway. A ativação automática respeita autenticação, workspace, schemas, referências e validade; não comprova a verdade do conteúdo. `memory_capabilities` informa a política efetiva. `manual` é uma opção para instalações que desejam manter propostas pendentes até a revisão por outro perfil; essa opção não é necessária para usar o sistema. Mudar a política afeta novas escritas, sem aprovar silenciosamente propostas antigas.

Exemplo sintético via CLI local, usando JSON no stdin:

```sh
printf '%s' '{"workspace":"example-project","content":"Decisão sintética: usar uma fonte canônica revisada."}' |
  npm run cli -- call memory_propose_write local-writer
```

Para integração stdio, execute `npm run mcp` no diretório da instalação com `STDIO_PROFILE` explícito. O perfil padrão gerado é `local-writer`; clientes só de leitura devem escolher `local-reader`. Acesso ao processo/ambiente local é uma fronteira confiável. Veja [integração de agentes](docs/AGENTS-INTEGRATION.md).

## Modelos OpenRouter

Quando `ENABLE_PROVIDER=true`, o Jove Memory usa uma matriz explícita de modelos especializados:

| Papel | Modelo | Uso |
| --- | --- | --- |
| Embeddings | `google/gemini-embedding-2` | Busca semântica e mídia multimodal, com 1536 dimensões |
| Decisions | `upstage/solar-decide` | Gate de escrita e travessia entre workspaces pela Decisions API |
| Rerank | `qwen/qwen3.8-flash` | Reordenação opcional dos candidatos recuperados |
| Knowledge | `deepseek/deepseek-v4-flash` | Extração de metadata e resumo auxiliar de consolidação |
| Synthesis | `stealth/space-bunny-alpha` | Síntese do pacote de contexto mantendo IDs de evidência |

Os três modelos generativos podem assumir fallback entre si dentro de suas tarefas. O modelo de decisão não recebe fallback generativo, porque o fluxo depende da probabilidade estruturada da Decisions API. Embeddings, fontes originais e conteúdo lossless continuam sendo a base persistida; resumos de modelo são metadata auxiliar e nunca substituem a evidência original.

Produção usa `OPENROUTER_API_KEY` como variável privada do Railway. Desenvolvimento local pode usar a mesma variável no processo ou `PROVIDER_API_KEY_FILE=private/openrouter.key`, mantendo o segredo fora de `.env` e do Git. O código continua aceitando `PROVIDER_API_KEY` como alias legado.

`npm run index -- example-project local-admin` indexa itens aceitos. Chamadas externas podem ter custo. Modelos distintos e dimensões diferentes não são comparados. Falhas semânticas são declaradas, preservando a recuperação textual; a travessia entre workspaces fecha quando seu gate falha.

Os limiares declarados são escrita **0,60** e travessia **0,75**, ambos **não calibrados para este projeto**. O gate de escrita é indicativo: score baixo ou provedor indisponível não bloqueiam a ativação no modo automático. A política é local e não exige chamada paga. Rerank é opcional e ordena candidatos sem transformá-los em fatos verificados.

## Produção Railway

A configuração pública [.railway/railway.ts](.railway/railway.ts) descreve Railpack, migration anterior ao deploy, healthcheck e recursos por Infrastructure as Code. A topologia tem um serviço Node, PostgreSQL com pgvector na rede privada e um Bucket Railway privado, com credenciais via variáveis de ambiente/referência. Não usa Compose em produção, storage próprio em produção, Redis ou disco persistente da aplicação.

Consulte o [procedimento operacional](docs/OPERATIONS.md). O arquivo IaC exige plan/apply explícitos; push de código não aplica infraestrutura. Serviços novos não leem o formato legado railway.json. O [estado da entrega](docs/STATUS.md) distingue configuração de validação remota. Dados antigos não são importados automaticamente. PRs públicos não devem receber variáveis ou bancos de produção.

## Verificação e documentação

```sh
npm run verify
npm run test:integration
npm audit --omit=dev
```

Integração usa bancos descartáveis e Bucket sintético no Compose próprio; exercita os 32 contratos, clientes MCP reais e backup/restauração. Não usa produção nem faz chamadas pagas. CI executa os mesmos gates. As imagens locais e as ações GitHub são fixadas por digest/commit.

- [Arquitetura e decisões](docs/ARCHITECTURE.md)
- [Segurança: público versus privado](docs/SECURITY.md)
- [Funcionalidades e mudanças de contrato](docs/PARITY.md)
- [Operação, produção e backups](docs/OPERATIONS.md)
- [Integração MCP e autorização](docs/AGENTS-INTEGRATION.md)
- [Avaliação e limites](docs/EVALUATION.md)
- [Estado verificado da entrega](docs/STATUS.md)

Licença Apache-2.0. O repositório distribui software e exemplos sintéticos; nenhuma memória, credencial ou configuração pessoal faz parte da distribuição.
