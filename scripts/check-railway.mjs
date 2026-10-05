import program from '../.railway/railway.ts';
import { createRailwayContext, validateGraph, RAILWAY_GRAPH_VERSION } from 'railway/iac';
const definition = await program(createRailwayContext({ environment: 'production', command: 'validate' }));
const errors = validateGraph({ version: RAILWAY_GRAPH_VERSION, resources: definition.resources, edges: [] });
if (errors.length) throw new Error(errors.join('\n'));
console.log('Railway SDK authoring evaluated. Live drift requires railway config plan.');
