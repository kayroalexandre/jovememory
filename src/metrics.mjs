import { ensure } from './config.mjs';
export function retrievalMetrics(cases) {
  ensure(cases.length,'EVALUATION','A labeled dataset is required.');
  const positive=cases.filter(c=>c.expected.length),negative=cases.filter(c=>!c.expected.length);
  const mean=(values)=>values.length ? values.reduce((a,b)=>a+b,0)/values.length:null;
  const per=positive.map(c=>{const expected=new Set(c.expected),found=c.actual.filter(id=>expected.has(id));const first=c.actual.findIndex(id=>expected.has(id));
    return {hit:found.length>0?1:0,precision:c.actual.length?found.length/c.actual.length:0,recall:found.length/expected.size,mrr:first<0?0:1/(first+1)};});
  return {cases:cases.length,positive_cases:positive.length,negative_cases:negative.length,hit_at_k:mean(per.map(x=>x.hit)),
    precision_at_k:mean(per.map(x=>x.precision)),recall_at_k:mean(per.map(x=>x.recall)),mrr:mean(per.map(x=>x.mrr)),
    negative_empty_rate:mean(negative.map(c=>c.actual.length===0?1:0)),absence_proven:false};
}
export function classify(scores,threshold) {
  let tp=0,fp=0,tn=0,fn=0;
  for(const row of scores) {if(row.score>=threshold) {if(row.relevant) tp++;else fp++;}else {if(row.relevant) fn++;else tn++;}}
  const precision=tp+fp ? tp/(tp+fp):0,recall=tp+fn ? tp/(tp+fn):0;
  return {threshold,tp,fp,tn,fn,precision,recall,f1:precision+recall ? 2*precision*recall/(precision+recall):0};
}
export function calibration(scores) {
  const training=scores.filter(x=>x.split==='training'),holdout=scores.filter(x=>x.split==='holdout');
  ensure(training.length>0 && holdout.length>0,'EVALUATION','Supply separate training and holdout labels.');
  const candidates=[...new Set([0,1,...training.map(x=>x.score)])].map(threshold=>classify(training,threshold)).sort((a,b)=>b.f1-a.f1 || b.threshold-a.threshold);
  return {recommendation:candidates[0],holdout:classify(holdout,candidates[0].threshold),configuration_changed:false,
    calibrated:false,notice:'These metrics describe supplied labels only. Review dataset provenance, leakage, size and representativeness before adopting a threshold.'};
}
