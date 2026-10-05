# Contribuição

Leia AGENTS.md e os contratos em docs/. Código e identificadores em inglês; documentação em pt-BR. Use Node 22.22 ou superior, npm ci e o Compose próprio para integração.

Antes de enviar mudança, execute `npm run verify`, `npm run test:integration` e `npm audit --omit=dev`. Testes não usam produção/provedores pagos. Atualize testes e documentos quando alterar contrato ou persistência. Não edite migrations já aplicadas: crie nova migration e atualização explícita do schema esperado.

Não inclua .env, corpus pessoal, tokens, snapshots, exports ou dados reais em issues/PRs. Use exemplos sintéticos. Um scanner de segredos não identifica todo conteúdo privado; revise o diff e o histórico. Use canal privado para vulnerabilidades.

Instale o hook com `git config core.hooksPath .githooks`. Dependências e ações/imagens ficam fixadas; atualizações devem passar pelos mesmos gates. O repositório distribui software, não perfis ou memórias do mantenedor.
