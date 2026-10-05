# jovememory

Memória persistente para agentes de desenvolvimento: fontes organizadas por workspace, busca híbrida, propostas revisadas, histórico auditável e retomada de projetos. Implementação nova, com desenvolvimento local e produção preparada para Railway.

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

1. Um perfil `writer` propõe conteúdo com `memory_propose_write`, ingestão, checkpoint ou registro de projeto.
2. Outro perfil, `reviewer`, aceita ou rejeita com motivo. Propostas não entram na recuperação comum.
3. `reader` pesquisa candidatos e relê fontes. Resultados incluem workspace, ID, hash, proveniência e limites de verificação.
4. Atualizações e consolidações criam propostas; somente o aceite invalida as versões anteriores, preservando história.

Exemplo sintético via CLI local, usando JSON no stdin:

```sh
printf '%s' '{"workspace":"example-project","content":"Decisão sintética: usar uma fonte canônica revisada."}' |
  npm run cli -- call memory_propose_write local-writer
```

Para integração stdio, execute `npm run mcp` no diretório da instalação com `STDIO_PROFILE` explícito. O perfil padrão gerado é `local-writer`; clientes só de leitura devem escolher `local-reader`. Acesso ao processo/ambiente local é uma fronteira confiável. Veja [integração de agentes](docs/AGENTS-INTEGRATION.md).

## Modelos opcionais

Sem provedor, busca textual, grafo, recência, revisão e continuidade funcionam. Para embeddings, gate indicativo e rerank, configure explicitamente `ENABLE_PROVIDER=true`, `PROVIDER_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` e `DECISION_MODEL`. O modelo deve suportar o contrato correspondente; imagem exige embeddings multimodais. Não há modelos/contas/chaves pessoais distribuídos.

`npm run index -- example-project local-admin` indexa itens aceitos. Chamadas externas podem ter custo. Modelos distintos e dimensões diferentes não são comparados. Falhas semânticas são declaradas, preservando a recuperação textual; a travessia entre workspaces fecha quando seu gate falha.

Os limiares declarados são escrita **0,60** e travessia **0,75**, ambos **não calibrados para este projeto**. Gate não aceita propostas automaticamente. Rerank é opcional e ordena candidatos sem transformá-los em fatos verificados.

## Produção Railway

A configuração pública [railway.json](railway.json) usa Railpack, migration anterior ao deploy e healthcheck. A topologia proposta tem um serviço Node, PostgreSQL com pgvector na rede privada e um Bucket Railway privado, com credenciais via variáveis de ambiente/referência. Não usa Compose em produção, MinIO próprio em produção, Redis ou disco persistente da aplicação.

Consulte o [procedimento operacional](docs/OPERATIONS.md) antes de ativar. Estar configurado para Railway não comprova um deploy saudável. Dados antigos não são importados automaticamente. PRs públicos não devem receber variáveis ou bancos de produção.

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
