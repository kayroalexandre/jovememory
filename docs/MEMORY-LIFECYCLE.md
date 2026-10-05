# Projetos, fontes e continuidade

## Engenharia escolhida

O fluxo usa versionamento temporal com histórico, evidências por hash, identidade
de repositório e autorização por capacidade. PostgreSQL/pgvector e SDK MCP continuam
como base. `jose` 6.2.12 acrescenta assinatura e validação padronizada de tokens
temporários; não há JWT decodificado sem verificar assinatura/claims.

[Graphiti](https://github.com/getzep/graphiti) oferece invalidação temporal em grafos,
mas exige backend de grafo e runtime próprios. [Mem0](https://docs.mem0.ai/) oferece
abstrações de memória e reconciliação. Não foram instalados: duplicariam armazenamento
e políticas que precisam permanecer integradas ao RLS/auditoria desta aplicação.
Esta decisão não atribui ao jovememory os resultados publicados desses frameworks.

## Fronteiras

| Conexão | Permissão | Conteúdo global |
| --- | --- | --- |
| Agente do projeto | writer temporário de um workspace | Não |
| Controlador local | provisioner em escopo autorizado | Não lê corpus |
| Observatório | observer em escopo autorizado | Somente métricas |
| Administração privada | admin em escopo autorizado | Leitura e administração explícitas |

O workspace tem o nome do repositório, preservando maiúsculas/pontos suportados.
Host/proprietário/repositório formam sua identidade. Worktrees do mesmo origin
compartilham workspace; branches e checkouts distintos podem observar hashes
diferentes, que são declarados como observações e não verdade global. Dois origins
distintos com o mesmo nome geram colisão, sem credencial ou mistura automática.
Sem origin confiável, o agente recebe somente status e orientação para conectar.

Configuração externa sintética do controlador:

```json
{
  "endpoint": "https://memory.example.invalid/mcp",
  "provisioner_token_file": "/external/private/controller.token"
}
```

O cliente inicia `node /installation/src/project-bridge.mjs` com cwd do projeto e
`JOVEMEMORY_BROKER_CONFIG` apontando ao arquivo externo. O conector não devolve o
token ao agente nem persiste token temporário no projeto. A chave de assinatura
fica em variável Railway/arquivo externo. Arquivos/configurações MCP com referência
de caminho são privados; nunca publicar a configuração resolvida.

## O que mudou e o que permanece válido

1. O conector observa hashes de arquivos Git antes das chamadas e a cada minuto.
2. Ao gravar fatos ligados a arquivos, o agente fornece `source_refs` com locator/hash
   corrente; o servidor compara à observação na transação.
3. Fonte alterada/ausente sinaliza `needs_revalidation` em leitura/contexto/manutenção;
   rerank e síntese também recebem esse estado para preservar incerteza.
4. O agente lê código/documentos e decide entre atualizar o fato, revalidá-lo ou
   retirá-lo. O sistema não pede aprovação de memória no modo automático.
5. Atualização cria sucessor e invalida versão anterior. Registro de mesma kind/key
   faz isso automaticamente; divergências explícitas exigem resolução consciente.
6. Checkpoint documenta resultado, referências atuais e trabalho restante. Feed
   `memory_changes` informa sequências de mutação sem snapshots de conteúdo.

Retirement conserva o texto e auditoria, mas retira o item da recuperação normal.
Dados fora da validade também são excluídos dessa recuperação; manutenção os inclui
para diagnóstico. `matches_observation` não significa testes aprovados ou afirmação
verdadeira. `untracked` exige verificar a fonte quando relevante. Uma memória antiga
pode continuar correta; tempo decorrido sozinho não autoriza invalidá-la.

## Métricas e limites reais

`memory_overview` pagina workspaces autorizados e informa itens ativos/históricos,
expirados, backlog vetorial, necessidade de revalidação, fontes ausentes, atividade,
chamadas/falhas, p95 e sínteses em fallback pago. Telemetria conserva apenas metadados
por 30 dias, com agregação de sete dias; não registra prompt, query, corpus ou token.
Não contabiliza chamadas diretas fora do serviço nem comprova economia de tokens,
calibração ou taxa de regressão. Falha de métricas não reverte a escrita.

O conector observa até 5000 arquivos por manifesto e 16 MiB por arquivo. Ignora
symlinks e caminhos privados. Observação parcial não infere remoção de fontes
omitidas. Conteúdo de arquivo e histórico de chat não são importados automaticamente.
O agente precisa registrar fatos e resultados; instruções MCP não garantem obediência
de todo cliente/modelo. Quando o cliente fecha, a observação local para. Produção
recebe as observações, mas não abre o filesystem do WSL.

Rota gratuita continua preferencial. Fallback pago usa os modelos baratos escolhidos,
ordena provedores por preço e não impõe teto desde 0.5.0. Limites de contexto, timeout,
contrato JSON/citações e disponibilidade do provedor permanecem independentes.

Fontes: [JOSE](https://github.com/panva/jose), [RLS PostgreSQL 17](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
e [anotações MCP não são fronteira de autorização](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).


O modo nativo `PROJECT_TOKEN_KEY_MODE=database-derived` deriva uma chave de
assinatura com HKDF-SHA256, domínio exclusivo e identidade do banco, a partir da
credencial runtime privada já gerida pelo Railway. Não usa a senha diretamente
como chave e não exporta o material derivado. Rotacionar essa credencial invalida
JWTs antigos. Uma chave independente em `PROJECT_TOKEN_SECRET`/arquivo externo
tem prioridade e permite rotação separada. `CONTROL_AUTH_PROFILES` acrescenta
controlador/observer sem sobrescrever perfis existentes.
