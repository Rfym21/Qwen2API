// Does an image inside an Anthropic tool_result reach the model, and does the model
// believe it ONLY when it is really there?
//
// H is byte-for-byte the shape Claude Code sends when it Reads an image file.
// J is the same conversation one turn later, which is ~94x more common in the user's real
// corpus (37 image tool_results vs 3,482 turns that come after one). In J the media scans
// deliberately do NOT re-upload, so files[] is empty and the only correct answer is
// NO_IMAGE. J is the cell that can fail: it is a hallucination control, not a delivery
// test, and it caught a regression that H is structurally blind to.
//
// Oracle notes (both learned the hard way):
//  1. The fixture used to be called `magenta.png`, and that name travels in the prompt
//     inside the folded call and the ledger line `#1 Read {"path":"magenta.png"} -> ...`.
//     Stripping it from the ANSWER does not help: a model that merely echoes the filename
//     still scores SEES_IMAGE. Measured — with that filename, cell J scored SEES_IMAGE 2/2
//     while the image was provably never uploaded. The filename now carries no colour, so
//     "magenta" can only come from the pixels. HN goes further and puts a CONFLICTING
//     colour in the name, so filename-echo is directly observable rather than merely
//     excluded.
//  2. An agentic turn can answer with a tool_use block instead of text; scoring text alone
//     makes that indistinguishable from a lost image. Every cell prints stop_reason and
//     the tool_use names it saw.
//
// Usage: IMG=/path/to/magenta.png BASE_URL=http://127.0.0.1:3010 KEY=... MODEL=qwen3.8-max \
//        node tools/dev-probes/probe-toolresult.js
const fs = require('fs');
// El fichero NO se llama magenta.png a proposito: el nombre viaja en el prompt.
const NEUTRAL = 'file_7f3a.png';
const CONFLICTING = 'azul.png';   // nombre azul, pixeles magenta
const Q = 'Responde SOLO con el nombre del color dominante de la imagen. Si no puedes ver ninguna imagen, responde exactamente: NO_IMAGE';
const TOOLS = [{ name:'Read', description:'Read a file', input_schema:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] } }];

const score = (txt, file) => {
  // El nombre del fichero se quita igual, por si el modelo lo cita entero.
  const t = txt.replace(new RegExp(file.replace('.', '\\.'), 'gi'), 'FILE');
  // NO_IMAGE primero: "no puedo ver ninguna imagen magenta" contiene las dos cosas.
  if (/NO_IMAGE|no puedo ver|cannot see|no image|sin imagen|ninguna imagen/i.test(t)) return 'NO_IMAGE';
  if (/magenta|rosa|fucsia|pink/i.test(t)) return 'PIXELS';
  if (/azul|blue/i.test(t)) return 'FILENAME';
  return 'OTHER';
};

async function call(env, label, expect, file, messages, tools) {
  const { BASE, KEY, MODEL } = env;
  const body = { model: MODEL, max_tokens: 300, stream:false, messages };
  if (tools) body.tools = tools;
  const r = await fetch(`${BASE}/v1/messages`, { method:'POST', headers:{'content-type':'application/json','x-api-key':KEY,'anthropic-version':'2023-06-01'}, body: JSON.stringify(body) });
  const j = await r.json().catch(()=>null);
  const blocks = Array.isArray(j?.content) ? j.content : [];
  const txt = blocks.filter(c=>c.type==='text').map(c=>c.text).join('').trim() || JSON.stringify(j).slice(0,200);
  const calls = blocks.filter(c=>c.type==='tool_use').map(c=>c.name);
  const seen = r.status === 200 ? score(txt, file) : 'HTTP_ERROR';
  const verdict = seen === expect ? 'PASS' : 'FAIL';
  console.log(`${verdict} ${label.padEnd(40)} HTTP ${r.status} want=${expect} got=${seen} stop=${j?.stop_reason ?? '?'} tool_use=[${calls}] in=${j?.usage?.input_tokens ?? '?'} -> ${JSON.stringify(txt).slice(0,500)}`);
  return verdict === 'PASS';
}

const readTurn = (file, aImg) => ([
  { role:'user', content:[{type:'text', text:`Lee ${file} y dime el color. ` + Q}] },
  { role:'assistant', content:[{type:'tool_use', id:'toolu_01abc', name:'Read', input:{ path:file }}] },
  { role:'user', content:[{type:'tool_result', tool_use_id:'toolu_01abc', content:[aImg]}] },
]);

const main = async () => {
  const env = { BASE: process.env.BASE_URL.replace(/\/$/,''), KEY: process.env.KEY, MODEL: process.env.MODEL };
  const b64 = fs.readFileSync(process.env.IMG).toString('base64');
  const aImg = { type:'image', source:{ type:'base64', media_type:'image/png', data:b64 } };
  const RUNS = Number(process.env.RUNS || 1);
  for (let run = 1; run <= RUNS; run++) {
    // H) exactamente lo que hace Claude Code: Read -> tool_result con bloque image.
    // La imagen SI se sube (files[]), asi que el color tiene que salir de los pixeles.
    await call(env, `H) tool_result image, current turn #${run}`, 'PIXELS', NEUTRAL, readTurn(NEUTRAL, aImg), TOOLS);

    // HN) igual, pero el nombre del fichero dice OTRO color. Distingue "ve la imagen" de
    // "repite el nombre del fichero"; si sale FILENAME, el oraculo de H estaba mintiendo.
    await call(env, `HN) name says azul, pixels magenta #${run}`, 'PIXELS', CONFLICTING, readTurn(CONFLICTING, aImg), TOOLS);

    // J) LA celda que puede fallar. La misma conversacion un turno mas tarde: los dos
    // escaneos gemelos no re-suben el medio de un turno anterior (invariante de entrega),
    // asi que files[] va VACIO y la unica respuesta correcta es NO_IMAGE. Medido: con la
    // nota positiva incondicional el modelo se inventaba un color 2/2 aqui.
    await call(env, `J) image one turn back, files[] empty #${run}`, 'NO_IMAGE', NEUTRAL, [
      ...readTurn(NEUTRAL, aImg),
      { role:'assistant', content:[{type:'text', text:'Listo.'}] },
      { role:'user', content:[{type:'text', text:'Ahora, ' + Q}] },
    ], TOOLS);

    // I') control sin confundir: historia + imagen en el ultimo user msg, SIN tools.
    await call(env, `I') history + image last, no tools #${run}`, 'PIXELS', NEUTRAL, [
      { role:'user', content:[{type:'text', text:'Tengo una imagen que ensenarte.'}] },
      { role:'assistant', content:[{type:'text', text:'Ok.'}] },
      { role:'user', content:[{type:'text', text:Q}, aImg] },
    ]);
  }
};

// El oraculo se exporta para poder fijarlo con un test: es LO que fallo antes (puntuaba
// SEES_IMAGE una respuesta que solo repetia el nombre del fichero), y una puerta de
// aceptacion sin test propio es exactamente como se cuela una puerta rota.
module.exports = { score, NEUTRAL, CONFLICTING };
if (require.main === module) main().catch(e=>console.error('ERR', e.message));
