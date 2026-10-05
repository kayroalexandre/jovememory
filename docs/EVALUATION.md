# Avaliação privada

Testes de contrato verificam código, isolamento e degradação. Não medem automaticamente qualidade de recuperação no corpus de uma pessoa, custo real, latência de provedor ou capacidade multimodal de um modelo específico. Valores antigos e fixtures sintéticas não calibram uma instalação nova.

## Recuperação

Coloque um JSON fora do repositório com objetos `workspace`, `query` e `expected` (lista de UUIDs relevantes). `expected: []` rotula uma consulta negativa. IDs e queries de corpus real são privados. Execute:

```sh
npm run evaluate -- retrieval /caminho/privado/labels.json local-reader
```

A avaliação chama `memory_search` com k=10 e informa Precision@10, Recall@10, Hit@10, MRR e proporção de consultas negativas sem resultados. Sem corpus/labels, não há avaliação. Distingue positivos e negativos; um braço degradado é contado explicitamente. `absence_proven` permanece falso.

Se o ambiente habilita chamadas externas, o comando exige também `--allow-provider`. Para comparar rerank, use um dataset de holdout idêntico e `--rerank --allow-provider`; compare métricas e regressões por cenário antes de habilitar no cliente. O script imprime métricas agregadas, sem textos/queries/nomes de workspace. Guarde o relatório em destino privado. Não execute benchmark pago só para fazer CI passar.

## Calibração de gate

Entrada privada: lista de objetos `score` (0..1), `relevant` (boolean) e `split` (`training` ou `holdout`). Labels devem vir de avaliação independente, com critérios explícitos. Execute:

```sh
npm run evaluate -- calibration /caminho/privado/gate-labels.json
```

O script escolhe no treino o limiar com maior F1, usando o maior limiar no empate, e avalia esse número no holdout separado. Retorna matriz de confusão, precisão, recall e F1. Não muda configuração e não declara a escala calibrada. Avalie tamanho, vazamento entre splits, representatividade e custo de falsas admissões. Um limiar com recall baixo não se torna correto porque teve zero falso positivo em poucas amostras.

Os padrões públicos continuam escrita 0,60 e travessia 0,75, **não calibrados**. O gate de escrita é indicativo; ativação automática é a política padrão e independe desse score ou da disponibilidade de modelo. Revisão separada é opção explícita `MEMORY_REVIEW_MODE=manual`. A recomendação de um modelo não comprova verdade, segurança ou autorização de conteúdo.

## Evidências já verificadas

`npm test` mede schemas, autorização, regras de orçamento, paths de ingestão, limites do provedor e métricas sintéticas. A integração usa PostgreSQL/S3 locais próprios e clientes oficiais MCP, exercitando os 32 nomes com dados sintéticos, além de RLS, revisão concorrente, media/SHA-256 e restore em banco vazio. Vetores e gates do cenário semântico são simulados. Não houve medição paga nem importação de dados antigos.
