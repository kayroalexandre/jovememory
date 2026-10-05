# Estado da entrega — 2026-10-05

## Implementado

32 ferramentas MCP, incluindo os 28 objetivos funcionais catalogados da aplicação anterior, com mudanças explícitas em PARITY.md. Código/configuração novos. HTTP autenticado e stdio com SDK oficial; persistência PostgreSQL/pgvector isolada por RLS; mídia S3 privada; propostas/revisão/histórico/consolidação; continuidade/registros; avaliação; snapshot/restore; ambiente de desenvolvimento próprio.

## Verificado localmente

Syntax/version, scanner público, 13 testes unitários e 15 cenários de integração (16 resultados TAP incluindo o teste principal), com todos os 32 nomes exercitados. Clientes MCP reais por HTTP/stdio, role runtime sem superuser/BYPASSRLS, autenticação/permissões/origin, concorrência de revisão e integridade/restauração de snapshot com mídia. Dependências: auditoria npm sem vulnerabilidade conhecida na consulta desta entrega.

Não houve leitura/importação de corpus pessoal, migração de dados antigos, alteração dos recursos antigos ou chamada paga de modelo. `.env` e `private/` contêm somente configuração nova da instalação local e são ignorados pelo Git.

## Limites e próximos gates

Repositório público novo publicado, com proteção de branch, CI obrigatório, proteção de push contra segredos, alertas de dependências e canal privado de vulnerabilidades. Produção ativada em projeto Railway privado separado: aplicação sem volume, PostgreSQL/pgvector com volume e rede privada sem proxy TCP público, Bucket nativo de mídia.

Smoke remoto observado com clientes MCP oficiais e conteúdo sintético: saúde de banco/schema/role runtime, recusa anônima e de Origin externo, catálogo de 32 ferramentas do administrador e catálogo restrito do leitor, escopo de workspace, proposta fora de busca antes da revisão, aceite por outro perfil, busca/releitura, mídia no Bucket real com roundtrip SHA-256/deduplicação, recusa HTTP 403 do acesso direto anônimo ao objeto S3, auditoria persistente e soft delete do item de teste. Tokens, endpoints da instalação e evidências permanecem somente em configuração privada/local ignorado.

Serviços novos do Railway não aplicam railway.json. A inicialização sem migration falhou no primeiro deploy; comandos e healthcheck foram corrigidos pela configuração nativa e um deploy novo pela fonte GitHub concluiu migration/provisionamento/start. A configuração pública passou para Infrastructure as Code; o SDK foi avaliado localmente. IaC não foi aplicado via CLI, e ausência de drift remoto não foi medida por plan. O serviço ativo foi configurado pelas ferramentas nativas.

Qualidade de corpus real, capacidade multimodal de um modelo específico, custo/latência e calibração dos limiares não foram medidos. Provedor pago permanece desabilitado; testes semânticos usam provedor simulado. Restore verificou banco e arquivos locais; não repopulou Bucket nem restaurou volume de produção. Política automática de backups nativos não foi configurada/verificada nesta entrega e deve ser definida conforme retenção exigida.

Dados/clientes antigos permanecem na instalação anterior. Uma importação futura precisa de inventário/exportação privados, transformação do schema e conferência de IDs/proveniência/hashes. Não se copia dump/configuração antiga para um repositório público.

O gate inicial no GitHub identificou uma imagem MinIO indisponível em runner sem cache. O S3 local foi substituído por SeaweedFS público com digest fixo, em volume novo, e a integração completa foi repetida. A produção continua usando Bucket nativo.
