# Plano e estado — 0.5.2

Documento vivo: descreve o que está implementado, o que foi corrigido nesta revisão,
o que continua em aberto e o que fazer em seguida. Números aqui são verificados por
`npm run verify` e `npm run test:integration`; qualquer afirmação sem verificação
executada está marcada como não medida.

Este repositório é o **ambiente de desenvolvimento**. O agente conectado por MCP conversa
com a instância de produção no Railway, não com este checkout — a topologia está descrita
em "Topologia de desenvolvimento versus produção". O fluxo pretendido é: alterar e
validar aqui, commit, PR, `main`, deploy, e só então smoke privado.

Branch `codex/project-memory-lifecycle`, base `3a6f09f`, mais duas releases. Versão
declarada: **0.5.2**. Commits feitos nesta sessão; `main` continua em `9d5c966` e nada foi
publicado ou implantado.

| Gate | Resultado |
| --- | --- |
| `npm run lint` (sintaxe, coerência de versão, Railway IaC) | passa |
| `npm run secret-scan` | passa |
| `npm test` | 32 testes, 32 passam |
| `npm run test:integration` | 28 resultados TAP, 27 cenários, todos passam |
| Cobertura de ferramentas MCP | 43/43 exercitadas com autorização e persistência reais |
| `npm audit --omit=dev` | 0 vulnerabilidades |

## O que esta revisão corrigiu

Bugs confirmados empiricamente antes de alterar o código, não por leitura:

1. **`memory_update_item` apagava a validade do antecessor.** O serviço passava
   `valid_from: undefined` explicitamente, e a combinação de objetos no `store` sobrescrevia
   o prazo do item substituído com `NULL`. Um fato com validade temporária virava
   permanente, sem registro na auditoria. Agora a janela é herdada quando omitida e só
   muda quando enviada explicitamente.
2. **Falhas de constraint viravam `INTERNAL`.** Duas revisões pendentes competindo pelo
   mesmo antecessor no modo manual produziam a mensagem "verifique a infraestrutura" para
   um conflito de usuário. Códigos `23505`, `23503`, `23514`, `40001` e `40P01` agora
   viram `CONFLICT`, `REFERENCE` ou `INPUT`.
3. **Nó inexistente não era validado.** `memory_move_item` e escrita com `node` caíam em
   violação de chave estrangeira. Agora são recusados com `NODE` antes do banco.
4. **Busca não determinística.** `graph()` e a busca lexical de mídia usavam `LIMIT` sem
   `ORDER BY`, e a fusão RRF depende da posição de cada braço. Repetir a mesma consulta
   podia produzir outra ordem.
5. **N+1 de transações.** `memory_project`, `memory_resume` e `memory_maintenance`
   abriam uma transação por item e reliam a tabela completa de fontes a cada item. Com
   `limit:100` e fontes observadas isso significava milhares de transações numa chamada.
6. **Custo do conector.** O broker re-hasheava toda a árvore de trabalho a cada chamada de
   ferramenta, apesar de a observação periódica de 60s já cobrir obsolescência. Passou a
   usar o estado barato do Git e reobserva quando ele muda.
7. **Carga não autenticada.** `/health` fazia duas consultas ao banco por requisição, e
   qualquer string com forma de JWT gastava uma transação antes de ser rejeitada.
8. **Payload de modelo sem orçamento.** Rerank e síntese recebiam conteúdo integral
   (até ~25 MiB) antes de qualquer truncamento; agora são limitados por
   `RERANK_PAYLOAD_BYTES` sem afetar a evidência devolvida.
9. **Linhas inalcançáveis por orçamento.** `bounded()` descartava linhas do fim da página
   mantendo um cursor que já passava além delas. O conteúdo sumia sem forma de recuperação.
10. **Regex de workspace desatualizada.** `scripts/evaluate.mjs` ainda usava o contrato
    anterior a 0.5.0 e rejeitava workspaces válidos como `Synthetic.App`.
11. **Ingestão perdia o heading** que já era usado no UUID determinístico e na prévia.
12. **Limites de PDF engolidos** como falha de extração, deixando um PDF grande anexado com
    texto vazio e indistinguível de um PDF sem texto.
13. **`memory_record.locator` ignorava** o contrato de locator seguro usado por `source_refs`.
14. **`memory_mutations` devolvia conteúdo integral** das linhas de auditoria, sem projeção
    e sem cursor.
15. **`tsx` não era dependência declarada**, funcionando apenas por acaso como transitiva
    de `railway`.

Cada correção tem teste de regressão. A reintrodução do bug 1 foi executada
deliberadamente para confirmar que os testes novos o detectam.

## Inconsistências de documentação corrigidas

- Contagem de ferramentas: `PARITY.md` e `EVALUATION.md` diziam 33; o serviço tem 43.
- `PARITY.md` se contradizia entre a linha de contagem e a seção de contrato 0.5.0.
- `CHANGELOG.md` parava em 0.1.0, com o pacote já em 0.5.0.
- `memory_connection_status` (ferramenta do bridge, fora do catálogo do serviço) nunca foi
  explicitado: um agente via broker vê 44 nomes.
- Cache de embeddings descrito como 128 entradas (transitivamente 129 antes da evasão).
- Limite de três candidatos na rota gratuita não documentado.
- Retenção de telemetria descrita como prazo, quando é aplicação preguiçosa por workspace.
- `LOCAL_DATABASE_PASSWORD`, `RESTORE_DATABASE_URL` e `RERANK_PAYLOAD_BYTES` ausentes de
  `.env.example`; `npm run dev` e `npm run project:mcp` não documentados.
- Enumeração incompleta dos valores preservados em `.railway/railway.ts`.

## Revisão do PR de 0.5.2

Uma revisão adversarial do diff de 0.5.2, antes do merge, bloqueou em dois pontos. Ambos
foram confirmados empiricamente e corrigidos, e as correções têm teste que falha com o bug
reintroduzido.

**Estado de fonte obsoleto em silêncio (alta, herdado de 0.5.1).** O estado barato do
repositório era `HEAD` mais `status --porcelain`. Porcelain não contém hash de conteúdo: um
arquivo já modificado, editado de novo sem commit, produz saída byte a byte idêntica. O
broker via estado idêntico, pulava o re-hash, e o hash de fonte ficava permanentemente
obsoleto — sem erro em lugar nenhum. Isso quebrava a invariante que sustenta
`needs_revalidation` e `memory_revalidate`. Verificado em repositório real: v2 e v3 do mesmo
arquivo sujo produzem o mesmo porcelain. O estado passou a incluir `git diff HEAD`, que é
sensível ao conteúdo e custa um subprocesso.

**Escalada de privilégio pelo roteamento do observatório (alta, nova em 0.5.2).** O broker
confiava no rótulo de papel do token: roteava qualquer ferramenta do catálogo do observador,
encaminhava argumentos sem injeção de workspace, e removia do catálogo do projeto as
ferramentas que aparecessem no catálogo do observador. Um `observer.token_file` apontado por
engano para um token de administrador transformaria o broker em repasse global de
prévio, com leitura e escrita cross-workspace. Hoje só era inerte porque `role: observer`
por acaso tem só `observe` — uma invariante não verificada.

Corrigido com allowlist explícita de `memory_overview` e verificação da **capacidade
efetiva** do token na conexão: o catálogo precisa conter as ferramentas do observatório e
nada fora delas, senão `OBSERVER_ROLE`. Conferir o papel por rótulo não servia, porque um
observador real não pode nem chamar `memory_capabilities`. O teste cobre as duas direções:
token de provisioner e token de administrador.

Também corrigidos na mesma passagem: ausência de detecção de queda do observatório (a
conexão morta sem erro mantinha `connected: true` para sempre); `configured` derivado da
lista de ferramentas em vez do bloco de configuração; `tools/list` do projeto derrubando o
observatório junto quando o endpoint de projeto falhava; guarda de reentrância e limpeza de
cliente MCP; colisão de `projects.repository_id` entre workspaces reportando mensagem
errada; e o braço semântico da busca de mídia sem desempate determinístico.

Ressalva sobre os testes: a primeira versão do teste de escalada passava mesmo com a
verificação removida, porque usava um token de provisioner — que a outra checagem já
recusava. O teste foi refeito com um token de administrador, que é o caso perigoso real, e
só então passou a falhar quando a verificação foi removida. Um teste que não falha com o bug
não prova nada.

## Falso positivo registrado

Uma revisão acusou conflito entre `DATABASE_URL` e `MIGRATION_DATABASE_URL` em
`.railway/railway.ts`, que tornaria o deploy de produção impossível. **Não é o caso:** o
serviço de aplicação não define `DATABASE_URL`, de modo que `runtimeDatabaseUrl` deriva a
credencial da role runtime a partir da credencial administrativa, e o `preDeploy` ativa o
bootstrap exatamente como `OPERATIONS.md` descreve. Nenhuma alteração foi feita ali, e o
comportamento foi conferido antes de descartar a hipótese.

## Limites conhecidos, declarados e não "corrigidos" por falta de medição

- **Limiares não calibrados.** 0,60 (escrita) e 0,75 (travessia) são declarados, não
  derivados de avaliação. O gate de escrita é indicativo e a ativação automática é a
  política padrão, independentemente do score.
- **`memory_feedback` não afeta a ordenação.** Grava um passo auditado de `importance` e o
  valor é visível em `memory_list`/`memory_read`, mas ordenação vem de `ts_rank_cd`,
  distância de vetor e data. Implementar isso mudaria o determinismo da recuperação e
  exigiria reavaliação com corpus rotulado.
- **`authority` de registro é inerte.** `canonical|supporting|historical` é persistido e
  relido, mas não filtra nem ordena.
- **Qualidade de recuperação não medida.** Não há corpus nem labels reais; só fixtures
  sintéticas.
- **Custo e latência reais não medidos.** Chamadas reais validaram disponibilidade, não
  desempenho.
- **Telemetria parcial.** Ferramentas sem `workspace` (`memory_version`,
  `memory_capabilities`, `memory_open_project`, `memory_overview`) não geram linha.
- **Sem BM25, sem índice ANN, sem piso de similaridade.** A busca vetorial é exata e pode
  devolver candidatos irrelevantes.
- **Sem OCR, sem descrição de imagem, sem transcrição de áudio/vídeo.**
- **Revisão e delete não são apagamento legal.** Rejeição e soft delete preservam histórico.

## Topologia de desenvolvimento versus produção

Verificado na máquina de desenvolvimento, não presumido:

| Item | Onde | Estado |
| --- | --- | --- |
| `jovememory` (MCP do agente) | `~/.config/opencode/opencode.json` | bridge local, mas `broker-production.json` |
| `jovememory-observatory` (MCP do agente) | `.opencode/opencode.json` do repo | remoto, Railway de produção |
| `broker-production.json` | `~/.config/jovememory/` | `https://jovememory-production.up.railway.app/mcp` |
| `broker-development.json` | `~/.config/jovememory/` | `http://127.0.0.1:3007/mcp` — **não referenciado** |
| Compose (postgres, storage) | `127.0.0.1:55471` / `:59071` | no ar, usado pelos testes |
| Servidor HTTP local | `127.0.0.1:3007` | **fora do ar** |

Consequência: **as duas conexões MCP do agente apontam para produção**. A memória escrita
por um agente durante o desenvolvimento cai no banco de produção, enquanto o código
descrito pode existir apenas na árvore de trabalho. Confirmado por sonda somente-leitura:
a produção declara `0.5.0` e não expõe o limite de payload de modelo introduzido em 0.5.1.

Isso é coerente com o fluxo pretendido (desenvolver local, validar, commit, PR, `main`,
deploy), mas deixa um buraco: o agente não tem um caminho de memória que aponte para o
servidor local, então não há como validar em memória de desenvolvimento antes do deploy.

A unificação do observatório em 0.5.2 remove a entrada `jovememory-observatory` do cliente
e resolve a metade disso que era configurável: um servidor de memória, um namespace de
ferramentas, e o token de leitura global restrito ao broker.

Opções, na ordem de menos risco:

1. **Subir o servidor local na 3007 e criar uma segunda entrada MCP** que aponte para
   `broker-development.json`, dando ao agente memória local explícita para o ciclo de
   desenvolvimento. A entrada de produção continua existindo separada, e o contrato do
   broker não muda. Exige `npm start` com `.env` e uma role controller local.
2. **Trocar a entrada ativa para `broker-development.json`** durante o desenvolvimento e
   voltar para produção antes de commit. Mais simples, mas alterna a fonte de memória no
   meio do trabalho e perde a continuidade entre deploys.
3. **Deixar como está** e passar a declarar o estado de deploy em cada registro, para que
   memória de produção nunca descreva código não implantado sem avisar.

A escolha é do operador: altera a configuração do cliente, não este repositório. O que
**não** deve mudar é o servidor — a separação de escopo já existe no contrato
(`role: observer` não inclui `observe`, e o writer do projeto nunca recebe `observe`).

## Por que o observatório deixa de ser um servidor separado

`memory_overview` nunca foi outro sistema: é a ferramenta nº 3 das 43 do mesmo servidor, e o
papel `observer` enxerga apenas ela. Os dois nomes MCP eram duas configurações de cliente
apontando ao mesmo serviço, com três consequências ruins:

- a entrada do observatório ficava no `.opencode/` do repositório, então o acesso às
  métricas globais dependia de estar no projeto certo;
- o token de leitura global vivia no `Authorization` da configuração do cliente, dentro do
  processo do agente;
- o agente via três conjuntos de ferramentas para um único serviço de memória.

Em 0.5.2 o broker serve os dois catálogos com duas credenciais da sua própria config
privada. O agente vê um servidor, e o token de leitura global fica restrito ao processo que
já deveria ter esse acesso — mais restrito do que a configuração anterior, não apenas
diferente. A assimetria entre `writer` e `observer` permanece e é o que torna impossível
trocar tudo por um único token.

## Plano de releases

Duas releases separadas, por escolha do operador:

- **0.5.1 — remediação.** As 15 correções desta revisão, com testes de regressão, mais a
  coerência de versão entre `VERSION`, `package.json` e `CHANGELOG.md`, agora verificada
  por `npm run lint`. Commit `bd79129`.
- **0.5.2 — unificação do observatório.** Mudança de contrato no broker: servir os dois
  catálogos com duas credenciais da config privada, encaminhar `memory_overview` por elas, e
  apagar a entrada `jovememory-observatory` do cliente. Fica sozinha porque altera o
  catálogo de ferramentas e o que o agente enxerga, e precisa de smoke próprio.

Fluxo de cada uma: gates completos locais, commit, PR contra `main`, merge, deploy pela
fonte, e **smoke privado depois do deploy**. Verificação local não prova operação.

## O que fazer em seguida

1. **Revisar o PR e decidir o merge.** Commits feitos nesta sessão; `main` continua em
   9d5c966 e nada foi implantado.
2. **Depois do deploy, configurar o bloco `observer` no broker de produção**, confirmar
   `memory_connection_status.observatory.connected` e só então remover a entrada
   `jovememory-observatory` do cliente. A ordem importa: remover a configuração antiga antes
   de confirmar a nova perde o acesso às métricas.
3. **Escolher a estratégia de memória local** entre as três opções acima, e executá-la
   antes do próximo ciclo de correções, para que validação em memória deixe de recair
   sobre produção.
4. **Definir e verificar política de backup nativo do Railway** conforme a retenção
   exigida. Hoje não há configuração nem verificação.
5. **Medir o limite de 3 candidatos gratuitos** contra o catálogo real antes de assumi-lo
   como adequado.
6. **Revisar `importance` e `authority`** com labels reais antes de dar qualquer efeito de
   ordenação a eles.
7. **Adicionar teste de integração de anexo de imagem** (PNG/JPEG/WebP). As verificações de
   assinatura existem em `src/media.mjs` e estão cobertas por teste unitário das
   assinaturas, mas o caminho completo de anexo com imagem não é exercitado na integração.
8. **Exercitar `pdf_extraction_unavailable`** com um PDF que o parser não consiga ler.
9. **Acompanhar a depreciação de `tsx`** ou substituir o `check-railway` por execução via
   SDK já empacotado, se a CLI deixar de exigir o loader.
10. **Revisar `railway config plan`** quando houver CLI disponível para assumir
    gerenciamento IaC, sem aplicar remotamente a partir deste repositório.

## Regra de manutenção

Não edite checksums de migrations aplicadas. Mudança de contrato exige migration,
documentação e teste no mesmo checkpoint. Não declare conformidade, calibração ou
produção saudável por existir implementação: cada afirmação precisa da verificação que a
sustenta, e resultado ausente é resultado ausente.
