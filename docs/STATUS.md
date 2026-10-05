# Estado da entrega — 2026-10-05

## Implementado

32 ferramentas MCP, incluindo os 28 objetivos funcionais catalogados da aplicação anterior, com mudanças explícitas em PARITY.md. Código/configuração novos. HTTP autenticado e stdio com SDK oficial; persistência PostgreSQL/pgvector isolada por RLS; mídia S3 privada; propostas/revisão/histórico/consolidação; continuidade/registros; avaliação; snapshot/restore; ambiente de desenvolvimento próprio.

## Verificado localmente

Syntax/version, scanner público, 13 testes unitários e 15 cenários de integração (16 resultados TAP incluindo o teste principal), com todos os 32 nomes exercitados. Clientes MCP reais por HTTP/stdio, role runtime sem superuser/BYPASSRLS, autenticação/permissões/origin, concorrência de revisão e integridade/restauração de snapshot com mídia. Dependências: auditoria npm sem vulnerabilidade conhecida na consulta desta entrega.

Não houve leitura/importação de corpus pessoal, migração de dados antigos, alteração dos recursos antigos ou chamada paga de modelo. `.env` e `private/` contêm somente configuração nova da instalação local e são ignorados pelo Git.

## Limites e próximos gates

A configuração Railway é preparação: implantação ativa e smoke remoto precisam ser observados depois da ativação dos recursos. Qualidade de corpus real, capacidade multimodal de um modelo específico, custo/latência e calibração dos limiares não foram medidos. Testes semânticos usam provedor simulado. Restore verificou banco e arquivos; não repopulou Bucket de produção.

Dados/clientes antigos permanecem na instalação anterior. Uma importação futura precisa de inventário/exportação privados, transformação do schema e conferência de IDs/proveniência/hashes. Não se copia dump/configuração antiga para um repositório público.
