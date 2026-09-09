// Does an image inside an Anthropic tool_result reach the model?
// H is byte-for-byte the shape Claude Code sends when it Reads an image file.
//
// Scoring note: an agentic turn can answer with a tool_use block instead of text.
// Scoring `content[].type === 'text'` alone makes that indistinguishable from a lost
// image, so every cell prints stop_reason and the tool_use names it saw.
const fs = require('fs');
const b64 = fs.readFileSync(process.env.IMG).toString('base64');
const BASE = process.env.BASE_URL.replace(/\/$/,''), KEY = process.env.KEY, MODEL = process.env.MODEL;
const Q = 'Responde SOLO con el nombre del color dominante de la imagen. Si no puedes ver ninguna imagen, responde exactamente: NO_IMAGE';
const aImg = { type:'image', source:{ type:'base64', media_type:'image/png', data:b64 } };
const TOOLS = [{ name:'Read', description:'Read a file', input_schema:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] } }];

async function call(label, messages, tools) {
  const body = { model: MODEL, max_tokens: 300, stream:false, messages };
  if (tools) body.tools = tools;
  const r = await fetch(`${BASE}/v1/messages`, { method:'POST', headers:{'content-type':'application/json','x-api-key':KEY,'anthropic-version':'2023-06-01'}, body: JSON.stringify(body) });
  const j = await r.json().catch(()=>null);
  const blocks = Array.isArray(j?.content) ? j.content : [];
  const txt = blocks.filter(c=>c.type==='text').map(c=>c.text).join('').trim() || JSON.stringify(j).slice(0,200);
  const calls = blocks.filter(c=>c.type==='tool_use').map(c=>c.name);
  // El nombre del fichero ES 'magenta.png': buscar /magenta/ en crudo puntua como
  // acierto cualquier respuesta que solo repita el nombre del fichero. Se quita primero.
  const scored = txt.replace(/magenta\.png/gi, 'FILE');
  const seen = /NO_IMAGE|no puedo ver|cannot see|no image|sin imagen/i.test(scored) ? 'NO_IMAGE'
    : (/magenta|rosa|fucsia|pink/i.test(scored) ? 'SEES_IMAGE' : 'OTHER');
  console.log(`${label.padEnd(38)} HTTP ${r.status} ${seen} stop=${j?.stop_reason ?? '?'} tool_use=[${calls}] in=${j?.usage?.input_tokens ?? '?'} -> ${JSON.stringify(txt).slice(0,500)}`);
}
(async () => {
  // H) exactamente lo que hace Claude Code: Read -> tool_result con bloque image
  await call('H) tool_result con image (Claude Code)', [
    { role:'user', content:[{type:'text', text:'Lee magenta.png y dime el color. ' + Q}] },
    { role:'assistant', content:[{type:'tool_use', id:'toolu_01abc', name:'Read', input:{ path:'magenta.png' }}] },
    { role:'user', content:[{type:'tool_result', tool_use_id:'toolu_01abc', content:[aImg]}] },
  ], TOOLS);
  // I') control sin confundir: historia + imagen en el ultimo user msg, SIN tools.
  // La version con tools era un experimento confundido: declaraba Read y la historia
  // pedia leer el fichero, asi que el modelo razonaba que aun no lo habia leido.
  await call("I') historia + image ultimo msg, sin tools", [
    { role:'user', content:[{type:'text', text:'Tengo una imagen que ensenarte.'}] },
    { role:'assistant', content:[{type:'text', text:'Ok.'}] },
    { role:'user', content:[{type:'text', text:Q}, aImg] },
  ]);
})().catch(e=>console.error('ERR', e.message));
