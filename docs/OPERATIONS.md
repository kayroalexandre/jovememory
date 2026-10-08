# Operação

## Desenvolvimento local

Use o fluxo de instalação do README. Compose é exclusivo do desenvolvimento: projeto `jovememory-dev`, PostgreSQL em `127.0.0.1:55471`, S3 em `127.0.0.1:59071`, API em `127.0.0.1:3007`. Os serviços e volumes não reutilizam a instalação anterior. Não use `down --volumes` para troubleshooting de uma instalação com dados.

Este checkout é o ambiente de desenvolvimento. A instância que os agentes acessam por
MCP é a de produção no Railway, e a escolha é feita na configuração do cliente, pelo
arquivo de broker: `broker-production.json` aponta para a Railway e `broker-development.json`
para `http://127.0.0.1:3007/mcp`. Verificar para qual endpoint o broker efetivo aponta é
parte de entender o que o agente está gravando. Registros escritos enquanto o broker aponta
para produção descrevem código que pode ainda não estar implantado; declare o estado de
deploy ao afirmar que uma correção está em vigor. A topologia observada e as opções de
separação estão em [PLAN.md](PLAN.md).

`local:init` gera credenciais. `migrate` exige `MIGRATION_DATABASE_URL`. `cli -- setup-local` habilita a role runtime com senha própria e cria apenas o bucket local declarado. `cli -- workspace <nome>` provisiona um workspace explícito. `npm start` verifica schema e abre HTTP; `npm run mcp` abre stdio com `STDIO_PROFILE` configurado.

A chave local fica fora do checkout, em `~/.config/jovememory/secrets/openrouter.key` (diretório 700, arquivo 600). O `.env` guarda apenas o caminho absoluto em `PROVIDER_API_KEY_FILE`. Para cadastrá-la sem exibição ou histórico:

```sh
mkdir -p ~/.config/jovememory/secrets
chmod 700 ~/.config/jovememory/secrets
read -rs -p "OpenRouter key: " provider_key
printf '%s\n' "$provider_key" > ~/.config/jovememory/secrets/openrouter.key
chmod 600 ~/.config/jovememory/secrets/openrouter.key
unset provider_key
printf '\n'
npm run provider:enable
```

O comando de ativação recusa um arquivo dentro do projeto, inclusive por symlink. `ENABLE_PROVIDER=true` sem chave utilizável bloqueia a inicialização; cadastrar a variável vazia não basta. Também aceita `PROVIDER_API_KEY_FILE` externo explicitamente definido no processo. Nunca copie a chave para o repositório ou para o `.env`.

Para criar perfis de escopo restrito, use `npm run cli -- profile <id> <reader|writer|reviewer|admin|observer|provisioner> <workspace...>`. O token e o JSON contendo seu hash ficam em `private/`. Adicione esse JSON a `AUTH_PROFILES` através de configuração privada e reinicie. `*` dá acesso a todos os workspaces; prefira nomes explícitos em produção. Perfis locais de bootstrap usam `*` por conveniência de desenvolvimento, não são copiados para produção.

Copiar `.env.example` para `.env` não substitui `npm run local:init`, que gera as senhas e perfis e também escreve `LOCAL_DATABASE_PASSWORD`. Sem essa variável o Compose não sobe. `npm run dev` reinicia o servidor HTTP ao alterar código.

## Produção Railway

Topologia: aplicação `jovememory`, serviço PostgreSQL com extensão pgvector e Bucket privado de mídia. A aplicação não precisa de volume. Banco deve usar rede privada, com volume/backups nativos; não gere proxy TCP público permanente. O PostgreSQL padrão do Railway não inclui necessariamente pgvector: selecione imagem/template apropriado.

O projeto Railway deve ser privado, embora o repositório de código seja público. Desative ambientes automáticos de PR no primeiro provisionamento; código de PR público não recebe credenciais de produção. Use serviços/dados/variáveis separados para homologação.

A configuração nativa do serviço deve declarar Railpack, build `npm ci --omit=dev`, pre-deploy `npm run migrate`, start `npm start`, healthcheck `/health` (120 segundos), restart ON_FAILURE (5 tentativas) e drenagem de 20 segundos. Banco e Bucket têm configurações próprias.

Serviços novos não leem `railway.json`/`railway.toml`. [.railway/railway.ts](../.railway/railway.ts) usa o SDK IaC fixado como dependência de desenvolvimento. Ele descreve a instalação provisionada e conserva com `preserve()` os valores privados: `AUTH_PROFILES`, `EXTRA_AUTH_PROFILES`, `CONTROL_AUTH_PROFILES`, `ENABLE_PROVIDER`, `PROJECT_TOKEN_SECRET`, `OPENROUTER_API_KEY` e `DATABASE_URL_PRIVATE`. Não distribui segredos nem cria workspace/conteúdo. Para uma instalação nova, crie os recursos e valores privados pelo Railway antes de reconciliar. Credenciais do Bucket são referências nativas; o domínio gerado não é publicado no arquivo.

O deploy desta instalação foi configurado pelas ferramentas nativas do Railway. A avaliação local/CI do SDK verifica a autoria; **não prova ausência de drift remoto**. Para assumir gerenciamento IaC, use CLI 5.42.1 ou superior, autentique e vincule explicitamente o projeto/ambiente, execute `railway config plan` e revise o diff antes de `railway config apply`. Não use `--include-variables` em pull, nem publique planos/evidências privados. Omitir recursos em uma configuração de projeto pode removê-los. Push/PR deste repositório não executa apply e CI não recebe credenciais Railway.

Configure pelo Railway:

| Variável | Origem/uso |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | Porta injetada pelo Railway, ou 3000 com targetPort correspondente |
| `PUBLIC_URL` | Origem HTTPS exata do domínio do serviço |
| `DATABASE_URL` | URL privada da role runtime `jovememory_app`, com senha exclusiva |
| `MIGRATION_DATABASE_URL` | URL administrativa privada; necessária só no job de migration/pre-deploy |
| `AUTH_PROFILES` | JSON privado de IDs, hashes, roles e workspaces de produção |
| `EXTRA_AUTH_PROFILES` | Perfis adicionais privados; mesclados à base com unicidade obrigatória de IDs/hashes |
| `MEMORY_REVIEW_MODE` | `automatic` por padrão; `manual` somente para instalações que desejam revisão separada |
| `ENABLE_PROVIDER` | Ative somente depois de cadastrar a chave OpenRouter |
| `OPENROUTER_API_KEY` | Segredo privado do Railway; nunca publicar ou colocar no repositório |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `OPENROUTER_DECISIONS_URL` | `https://openrouter.ai/api/alpha/decisions` |
| `EMBEDDING_MODEL` / dimensão | `google/gemini-embedding-2` / `1536` |
| `DECISION_MODEL` | `upstage/solar-decide` |
| `RERANK_MODEL` | `qwen/qwen3.8-flash` |
| `KNOWLEDGE_MODEL` | `deepseek/deepseek-v4-flash` |
| `SYNTHESIS_MODEL` | `openrouter/free`; inferência de contexto seletiva |
| `FREE_INFERENCE_PREFERENCES` | IDs gratuitos preferidos, separados por vírgula; filtrados pelo catálogo atual |
| `INFERENCE_FALLBACK_MODELS` | `deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash,xiaomi/mimo-v2.5` |
| `PROJECT_TOKEN_SECRET` | Chave aleatória de 256 bits em hex, segredo nativo para enrollment dinâmico |
| `PROJECT_TOKEN_SECRET_FILE` | Alternativa local: caminho externo a arquivo privado 600 |
| `S3_ENDPOINT` | `${{Media.ENDPOINT}}` |
| `S3_BUCKET` | `${{Media.BUCKET}}` — o nome técnico do S3, não o rótulo exibido no Railway |
| `S3_ACCESS_KEY_ID` | `${{Media.ACCESS_KEY_ID}}` |
| `S3_SECRET_ACCESS_KEY` | `${{Media.SECRET_ACCESS_KEY}}` |
| `S3_REGION` | `auto`, conforme endpoint/credenciais do Bucket |

Após migration, provisionar a role runtime com LOGIN e senha própria pela conexão administrativa. Não usar a senha do owner para a role runtime. Não expor SQL com segredo em histórico de shell/chat. `setup-local` é restrito ao ambiente local e não opera Railway.

No primeiro provisionamento, deixar `DATABASE_URL` ausente ativa bootstrap: migration e runtime derivam uma senha exclusiva por HMAC-SHA256 da credencial administrativa nativa e da identidade do banco, sem escrever ou imprimir o segredo. `APP_DATABASE_PASSWORD` opcional pode substituir por uma senha aleatória independente de 64 caracteres hex. A URL de runtime usa a role `jovememory_app`; healthcheck recusa conexão superuser/BYPASSRLS. Esse modo simplifica o primeiro deploy; a aplicação ainda recebe a variável administrativa necessária ao pre-deploy. Para isolamento de privilégios completo, use um serviço administrativo separado para migrations e deixe só `DATABASE_URL` runtime no serviço público.

Provisionar o primeiro workspace requer uma operação administrativa explícita. No primeiro deploy, pode-se executar um único pre-deploy `npm run migrate && npm run cli -- workspace <nome-autorizado>` na configuração privada do serviço. Depois de observar sucesso, restaurar o pre-deploy para `npm run migrate`. O comando é idempotente e não cria conteúdo. Não mantenha nomes de workspaces pessoais em configuração pública. Redeploy de um build existente pode conservar o snapshot anterior de configurações: após mudanças, confirme os comandos nos logs de um deploy novo pela fonte GitHub.

O domínio deve apontar apenas para o serviço HTTP. Banco/S3 não têm páginas públicas. Memórias ativadas recebem embedding automaticamente. Falhas são declaradas sem perder a escrita. Backlog anterior exige `npm run index`; rerank de busca/contexto é padrão e aceita `rerank=false`. Um fluxo pode combinar chamadas de até 30 segundos por tentativa; configure o timeout de execução do cliente MCP em 240 segundos para permitir os fallbacks.

Um deploy só é operacional depois de migrations, healthcheck, `tools/list`, chamada MCP autenticada, recusa de chamada anônima e verificação de escopo. Saúde não testa provedor/S3; esses caminhos têm smoke separado. Recursos staged são preparação, não produção ativa.

Fontes: [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), [pgvector](https://docs.railway.com/guides/rag-pipeline-pgvector), [Bucket e referências](https://docs.railway.com/storage-buckets), [isolamento por ambiente](https://docs.railway.com/guides/isolate-staging-production).

## Backup e verificação

Execute `npm run backup -- /caminho/privado/fora-do-repositorio/backup-novo` com configuração administrativa e S3 da instalação. Precisa de `pg_dump` compatível com a versão do servidor. O snapshot repeatable-read é exportado para o dump; fingerprints e ponteiros de mídia pertencem ao mesmo snapshot. Objetos têm chaves imutáveis; mídia é copiada e validada por tamanho/SHA-256. Manifest guarda fingerprints por tabela e hash do dump; não guarda credenciais. O diretório não pode resolver dentro deste repositório, nem por symlink.

Use uma pasta nova. Falhas deixam arquivos privados parciais **sem um manifest de sucesso**; preserve-os para diagnóstico ou limpe somente a pasta dessa tentativa. Backups contêm todo o banco/auditoria/mídia, não apenas itens ativos. O destino tem modo 700; arquivos 600. Isso não cifra o conteúdo: use armazenamento privado cifrado e controle de acesso externo.

Para verificar, crie explicitamente banco descartável vazio `jovememory_restore_<identificador>` numa infraestrutura apropriada, defina `RESTORE_DATABASE_URL` em ambiente privado e execute:

```sh
npm run backup:verify -- /caminho/privado/backup-novo
```

O comando recusa banco não descartável ou não vazio; verifica dump e objetos, restaura o banco e compara todas as tabelas com os fingerprints do manifest. Não apaga um banco existente nem altera produção. Não repopula S3: valida os arquivos copiados e informa esse limite. A recuperação operacional de mídia exige copiar cada `object_key` do manifest para um Bucket privado vazio e repetir verificações de hash antes de ligar a aplicação. Credenciais/perfis operacionais e políticas de plataforma são recuperados por procedimento independente.

Para volumes PostgreSQL Railway, habilite backups nativos conforme retenção/recuperação exigidas. Um snapshot de volume não substitui teste de restore nem inclui automaticamente o Bucket. Não use o filesystem efêmero do app como destino durável de backup.

## Indexação e qualidade

`npm run index -- <workspace> <perfil-admin>` percorre memórias aceitas elegíveis e indexa as sem o modelo ativo. `--force` refaz também vetores do mesmo modelo, necessário ao mudar dimensão. Cada item é verificado novamente por hash ao persistir. O comando pagina com `as_of` retornado pela página anterior; alterar ou omitir esse valor faz o cursor ser recusado. Falha interrompe o comando sem invalidar itens; repetir retoma com o modelo ativo. Indexação é paga quando o provedor está habilitado e nunca acontece na instalação.

Limiares permanecem declarados/não calibrados; avaliação privada está em [EVALUATION.md](EVALUATION.md). Não diminua números para simular sucesso de recuperação.

## Publicação e manutenção

Antes de cada publicação: revisar arquivos staged, executar `npm run verify`, integração e auditoria de dependências. Hooks podem ser instalados com `git config core.hooksPath .githooks`. Scanner é complementar à revisão de conteúdo pessoal. CI usa permissões somente leitura e não tem segredos de produção. Dependabot sugere atualizações; versões de ações/imagens devem ser revistas, não flutuar automaticamente.

Atualize código, migrations e contratos no mesmo checkpoint. Não edite checksums de migrations aplicadas. Alterações de modelo/dimensão requerem reindexação consciente; mudanças incompatíveis de schema/contrato precisam de plano de dados. O banco novo não reutiliza schema/dumps antigos sem transformação explícita e validação privada.

## Provisionamento por projeto e inferência auxiliar

A versão 0.3.0 exige schema 2 e aplica a migration 002 no pre-deploy. Depois de autenticar um cliente administrativo, `memory_create_workspace({workspace:"example-project"})` cria o registro explicitamente, com auditoria e sem duplicar a operação ao repetir. Conceda o nome ao perfil de projeto em `EXTRA_AUTH_PROFILES`, preservando os perfis da base; cadastro do workspace e autorização são operações distintas. Guarde novos tokens/perfis em armazenamento privado fora do checkout. Não substitua listas de perfis existentes sem reconciliá-las.

O cliente deve associar cada projeto ao workspace correspondente e usar uma credencial limitada a ele. Em OpenCode, configuração por projeto pode sobrescrever o servidor MCP global; use referências a tokens externos e mantenha essas associações fora do Git. A configuração efetiva e o perfil remoto precisam ser verificados no diretório do projeto. Reinicie/recarregue o cliente após alterar configuração; uma sessão existente pode manter ferramentas antigas.

Na configuração local padrão, a API usa porta 3007 para reduzir conflito com servidores de aplicações na porta 3000. Instalações existentes precisam ajustar `PORT` e `PUBLIC_URL` privados juntos; produção conserva a porta nativa configurada pelo Railway.

`memory_capabilities.inference` informa a política: inferência auxiliar somente mediante pedido do agente. Escritas com `enrich:true`, contexto com `synthesize:true` e consolidação com `summarize:true` podem chamar modelos adicionais; as escolhas não exigem revisor humano. Embeddings e rerank continuam padrão, e decisão permanece indicativa. Execute smoke pago separado do healthcheck para validar o provedor e seus fallbacks.

## Validar a rota gratuita — 0.4.0

Depois de alterar variáveis, faça build novo da fonte e confirme `memory_capabilities.models.synthesis`, preferências e ausência de teto pago. Use conteúdo sintético para `memory_context(synthesize:true)`; confira `synthesis.model` efetivo, `synthesis.routing.tier`, citações e degradação. `free` significa tentativa sob teto zero; `paid_fallback` declara uso do fallback pago. O roteador gratuito geral não é um ranking de inteligência. O catálogo atual e os preços devem ser revistos ao trocar preferências. Desde 0.5.0, o teto zero se aplica somente às tentativas gratuitas; chamadas de fallback pago não têm teto de preço.

Associe cada cliente ao workspace do próprio projeto e confirme o perfil antes de gravar. O workspace da aplicação de memória guarda somente contexto da própria aplicação; implementação e backlog de clientes pertencem aos workspaces correspondentes. Auditoria e versões históricas são preservadas quando uma nota é realocada; busca normal exclui a origem apagada. Não trate a memória da aplicação como workspace global para projetos sem configuração.

## Conector automático e observatório — 0.5.0

Aplique migration 003 antes do runtime. Configure a chave aleatória de assinatura
com `PROJECT_TOKEN_SECRET` no Railway; no WSL use `PROJECT_TOKEN_SECRET_FILE` para
arquivo externo 600. Não reutilize chave OpenRouter, senha de banco ou token MCP.
O controlador precisa de perfil `provisioner`, escopo declarado e token externo.
`observer` é um perfil independente que só lê overview global; ele não possui
permissões reader, writer ou admin. Preserve os perfis existentes ao acrescentar
os novos hashes em `EXTRA_AUTH_PROFILES`.

O arquivo externo `~/.config/jovememory/broker.json` guarda endpoint e caminho do
token de controlador. Registre o processo `node /caminho/instalacao/src/project-bridge.mjs`
como MCP local do cliente, com cwd do projeto e ambiente `JOVEMEMORY_BROKER_CONFIG`.
No OpenCode 2.0.23, o processo local recebe o diretório da localização efetiva;
configurações antigas por projeto que substituem o servidor global devem ser
reconciliadas. Segredos/configurações privadas nunca pertencem ao Git do projeto.

Ao conectar, o conector cria/vincula workspace, obtém token de um dia em memória,
observa arquivos versionados e expõe catálogo scoped. Um processo por projeto
continua conferindo fontes a cada minuto. Fechar o cliente encerra essa observação;
produção não tem acesso independente ao filesystem WSL. Limite: 5000 fontes por
observação e 16 MiB por arquivo; symlinks, caminhos privados e arquivos não versionados
não são enviados. Observação parcial não marca arquivos omitidos como apagados.

Confirme `memory_connection_status.bound`, `memory_capabilities.profile`, criação
idempotente e negativa de outro workspace. Overview global exige perfil observer
ou admin; nunca entregue token admin/provisioner ao modelo via catálogo ou resposta.
A revogação incrementa epoch e derruba credenciais emitidas, sem remover conteúdo.
Controlador autorizado pode reconectar e emitir credencial nova; revogar controlador
ou rotacionar sua configuração é operação independente.

Não existe teto pago de inferência desde 0.5.0. A seleção permanece barata e
`provider.sort=price`; free usa preços zero. Timeout, disponibilidade, contrato JSON
ou saldo do provedor ainda podem degradar síntese e não são corrigidos pela remoção
do teto. Compare classe da rota efetiva, não o nome lógico do roteador.


O modo nativo `PROJECT_TOKEN_KEY_MODE=database-derived` deriva uma chave de
assinatura com HKDF-SHA256, domínio exclusivo e identidade do banco, a partir da
credencial runtime privada já gerida pelo Railway. Não usa a senha diretamente
como chave e não exporta o material derivado. Rotacionar essa credencial invalida
JWTs antigos. Uma chave independente em `PROJECT_TOKEN_SECRET`/arquivo externo
tem prioridade e permite rotação separada. `CONTROL_AUTH_PROFILES` acrescenta
controlador/observer sem sobrescrever perfis existentes.
