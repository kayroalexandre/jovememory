# Segurança e distribuição pública

## O que pertence ao repositório

Código, migrations, contratos, documentação genérica, lockfile, CI, configuração declarativa de deploy, nomes de variáveis e exemplos sintéticos. Nomes de serviços genéricos e portas locais não são credenciais.

## O que fica privado

Tokens de cliente, chaves de provedor/S3, URLs de banco com senha, `.env`, configuração de perfis de uma instalação, nomes reais de workspaces, corpus, mídia, consultas, hashes de fontes reais, auditorias, exportações, backups, logs e evidências de uso pessoal. Não basta remover senhas: conteúdo e metadados também podem ser sensíveis.

No local, `.env` tem modo 600 e `private/` modo 700; arquivos de token têm modo 600. Backups devem ficar **fora do repositório**, inclusive ao resolver symlinks. No Railway, valores privados ficam em variáveis de ambiente ou referências nativas. Tokens em `AUTH_PROFILES` são hashes SHA-256 de segredos aleatórios de 256 bits; o token bruto só fica com o cliente. Não use senhas humanas como token.

`.gitignore` impede inclusão rotineira. `secret-scan` verifica arquivos públicos, paths proibidos, symlinks, binários e padrões de credencial, incluindo conteúdo staged. Hook local executa esse scanner no commit. CI adiciona auditoria de dependências; a revisão humana de dados pessoais continua necessária. Scanner não prova ausência de dados sensíveis e não substitui revisão do diff.

## Fronteiras de confiança

`reader` lê; `writer` propõe e registra feedback; `reviewer` aceita/rejeita e faz soft delete; `admin` provisiona relações/indexação e pode usar outras operações. Toda ferramenta verifica permissão e workspace; o catálogo só anuncia operações permitidas ao perfil. Consolidação/atualização nunca substituem fontes antes da revisão. Não entregue credencial de revisão ou administração a um agente que deve somente propor.

O HTTP exige Bearer token e valida Host/Origin. Não há CORS aberto, cookies, formulário HTML ou segredos em URL. `/health` só informa disponibilidade genérica. A aplicação não loga corpo, cabeçalhos Authorization, SQL privado ou erros brutos de provedor. Respostas de erro são categorias genéricas. Métodos de sessão GET/DELETE não se aplicam ao HTTP stateless e recebem 405.

MCP remoto usa HTTPS no Railway. Bearer estático não é OAuth: clientes que exigem descoberta/autorização OAuth precisam de uma camada própria; não há certificação de conformidade universal de clientes. Em stdio, acesso ao processo e ao ambiente é confiável; escolha perfil explícito e mantenha stdout reservado ao protocolo.

PostgreSQL e S3 devem permanecer privados. Use `DATABASE_URL` de role runtime sem superuser/BYPASSRLS; reserve `MIGRATION_DATABASE_URL` ao provisionamento/migration. O pre-deploy nativo compartilha o ambiente do serviço com o runtime: portanto a credencial de migration ainda está nessa fronteira administrativa. Para separação completa, execute migrations num job administrativo separado e remova essa variável/comando do serviço principal. RLS não protege contra alguém com controle de processo, ambiente ou role administrativa.

## Limites implementados

HTTP: corpo até 8 MiB, 32 requisições em processamento; schema estrito sem coerção. Stdio: buffer SDK até 8 MiB. Resultado de ferramenta até 8 MiB, antes da duplicação textual/structuredContent do envelope MCP. Conteúdo por item até 256 KiB; ingestão até 100 arquivos, 2 MiB e 1000 seções. Mídia até 4 MiB; PDF até 100 páginas e 256 KiB de texto. Contexto padrão 16 KiB, teto configurável pela chamada até 256 KiB.

Provedor: até 4 chamadas simultâneas, request até 8 MiB, resposta até 1 MiB, deadline de 30 segundos e redirects recusados. Não há retries automáticos pagos. Cache limitado e falhas explícitas. Cotas de uso financeiro devem também ser definidas no provedor/Railway; limites técnicos não são um orçamento financeiro.

PDF usa parser sem avaliação de código e sem OCR. Imagens verificam assinaturas para PNG/JPEG/WebP; texto usa UTF-8 estrito. Outros tipos permitidos são declarações de MIME, não uma certificação do arquivo. A aplicação retorna bytes autenticados; não serve HTML/SVG como uma página executável. Extração PDF indisponível preserva os bytes e informa a limitação. Hash SHA-256 é verificado em leitura e backup; ETag não substitui integridade.

Conteúdo recuperado pode conter prompt injection. É sempre dado não confiável. Busca fornece candidatos, não fatos confirmados nem autorização de execução. Referências, `basis` e autoridade são declarações revisadas, não certificações externas.

## Incidente e retenção

Se uma credencial for publicada, revogue/rotacione no sistema emissor, remova dos clientes e trate o histórico Git como potencialmente copiado. Apagar a linha atual não torna o segredo novamente seguro. Troque hashes/perfis e reinicie o serviço. Se conteúdo pessoal vazar, considere clones, caches, artefatos, logs e backups, não apenas o HEAD.

Backups contêm dados privados e snapshots da auditoria. Proteja-os com permissões e armazenamento cifrado; as chaves/variáveis operacionais não entram no manifest. Há verificação de restore em banco vazio com nome explícito. A purga física de conteúdo/auditoria e um regime legal de retenção não estão implementados; exigem política e procedimento próprios.

Reporte vulnerabilidades em canal privado do mantenedor ou em GitHub Private Vulnerability Reporting, quando habilitado. Não abra issue pública com tokens, dados reais, dumps ou corpo de requests sensíveis.
