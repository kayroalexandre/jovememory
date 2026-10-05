# Operação

## Desenvolvimento local

Use o fluxo de instalação do README. Compose é exclusivo do desenvolvimento: projeto `jovememory-dev`, PostgreSQL em `127.0.0.1:55471`, S3 em `127.0.0.1:59071`, API em `127.0.0.1:3000`. Os serviços e volumes não reutilizam a instalação anterior. Não use `down --volumes` para troubleshooting de uma instalação com dados.

`local:init` gera credenciais. `migrate` exige `MIGRATION_DATABASE_URL`. `cli -- setup-local` habilita a role runtime com senha própria e cria apenas o bucket local declarado. `cli -- workspace <nome>` provisiona um workspace explícito. `npm start` verifica schema e abre HTTP; `npm run mcp` abre stdio com `STDIO_PROFILE` configurado.

Para criar perfis de escopo restrito, use `npm run cli -- profile <id> <reader|writer|reviewer|admin> <workspace...>`. O token e o JSON contendo seu hash ficam em `private/`. Adicione esse JSON a `AUTH_PROFILES` através de configuração privada e reinicie. `*` dá acesso a todos os workspaces; prefira nomes explícitos em produção. Perfis locais de bootstrap usam `*` por conveniência de desenvolvimento, não são copiados para produção.

## Preparação Railway

Topologia: aplicação `jovememory`, serviço PostgreSQL com extensão pgvector e Bucket privado de mídia. A aplicação não precisa de volume. Banco deve usar rede privada, com volume/backups nativos; não gere proxy TCP público permanente. O PostgreSQL padrão do Railway não inclui necessariamente pgvector: selecione imagem/template apropriado.

O projeto Railway deve ser privado, embora o repositório de código seja público. Desative ambientes automáticos de PR no primeiro provisionamento; código de PR público não recebe credenciais de produção. Use serviços/dados/variáveis separados para homologação.

`railway.json` usa Railpack e declara `npm run migrate` como pre-deploy, `npm start` e `/health`. Configure pelo Railway:

| Variável | Origem/uso |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | Porta injetada pelo Railway, ou 3000 com targetPort correspondente |
| `PUBLIC_URL` | Origem HTTPS exata do domínio do serviço |
| `DATABASE_URL` | URL privada da role runtime `jovememory_app`, com senha exclusiva |
| `MIGRATION_DATABASE_URL` | URL administrativa privada; necessária só no job de migration/pre-deploy |
| `AUTH_PROFILES` | JSON privado de IDs, hashes, roles e workspaces de produção |
| `ENABLE_PROVIDER` | `false` inicialmente; habilite após configurar modelo/chave e limites de custo |
| `PROVIDER_API_KEY`, modelos/dimensão | Valores privados/selecionados pelo operador; sem chave/modelo pessoal distribuído |
| `S3_ENDPOINT` | `${{Media.ENDPOINT}}` |
| `S3_BUCKET` | `${{Media.BUCKET}}` — o nome técnico do S3, não o rótulo exibido no Railway |
| `S3_ACCESS_KEY_ID` | `${{Media.ACCESS_KEY_ID}}` |
| `S3_SECRET_ACCESS_KEY` | `${{Media.SECRET_ACCESS_KEY}}` |
| `S3_REGION` | `auto`, conforme endpoint/credenciais do Bucket |

Após migration, provisionar a role runtime com LOGIN e senha própria pela conexão administrativa. Não usar a senha do owner para a role runtime. Não expor SQL com segredo em histórico de shell/chat. `setup-local` é restrito ao ambiente local e não opera Railway.

No primeiro provisionamento, deixar `DATABASE_URL` ausente ativa bootstrap: migration e runtime derivam uma senha exclusiva por HMAC-SHA256 da credencial administrativa nativa e da identidade do banco, sem escrever ou imprimir o segredo. `APP_DATABASE_PASSWORD` opcional pode substituir por uma senha aleatória independente de 64 caracteres hex. A URL de runtime usa a role `jovememory_app`; healthcheck recusa conexão superuser/BYPASSRLS. Esse modo simplifica o primeiro deploy; a aplicação ainda recebe a variável administrativa necessária ao pre-deploy. Para isolamento de privilégios completo, use um serviço administrativo separado para migrations e deixe só `DATABASE_URL` runtime no serviço público.

O domínio deve apontar apenas para o serviço HTTP. Banco/S3 não têm páginas públicas. Um deploy só é operacional depois de migrations, healthcheck, `tools/list`, chamada MCP autenticada, recusa de chamada anônima e verificação de escopo. Saúde não testa provedor/S3; esses caminhos têm smoke separado. Recursos staged são preparação, não produção ativa.

Fontes: [Railway config](https://docs.railway.com/config-as-code/reference), [pgvector](https://docs.railway.com/guides/rag-pipeline-pgvector), [Bucket e referências](https://docs.railway.com/storage-buckets), [isolamento por ambiente](https://docs.railway.com/guides/isolate-staging-production).

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

`npm run index -- <workspace> <perfil-admin>` percorre memórias aceitas elegíveis e indexa as sem o modelo ativo. `--force` refaz também vetores do mesmo modelo, necessário ao mudar dimensão. Cada item é verificado novamente por hash ao persistir. Falha interrompe o comando sem invalidar itens; repetir retoma com o modelo ativo. Indexação é paga quando o provedor está habilitado e nunca acontece na instalação.

Limiares permanecem declarados/não calibrados; avaliação privada está em [EVALUATION.md](EVALUATION.md). Não diminua números para simular sucesso de recuperação.

## Publicação e manutenção

Antes de cada publicação: revisar arquivos staged, executar `npm run verify`, integração e auditoria de dependências. Hooks podem ser instalados com `git config core.hooksPath .githooks`. Scanner é complementar à revisão de conteúdo pessoal. CI usa permissões somente leitura e não tem segredos de produção. Dependabot sugere atualizações; versões de ações/imagens devem ser revistas, não flutuar automaticamente.

Atualize código, migrations e contratos no mesmo checkpoint. Não edite checksums de migrations aplicadas. Alterações de modelo/dimensão requerem reindexação consciente; mudanças incompatíveis de schema/contrato precisam de plano de dados. O banco novo não reutiliza schema/dumps antigos sem transformação explícita e validação privada.
