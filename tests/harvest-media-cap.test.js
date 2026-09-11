const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { flattenAnthropicMessages, buildInternalRequest } = require('../src/controllers/anthropic.js');
const { harvestCurrentTurnMedia, HARVEST_MEDIA_CAP } = require('../src/utils/chat-helpers.js');

// Por que existe este fichero.
//
// El barrido de medios del turno en curso esta escrito DOS veces: la funcion exportada
// chat-helpers.js#harvestCurrentTurnMedia (ruta OpenAI) y el bucle en linea de
// anthropic.js#buildInternalRequest (ruta Anthropic — la que corre Claude Code). Son
// gemelos declarados y el invariante de entrega de imagenes depende de que sigan siendolo.
//
// El tope por turno estaba declarado como DOS literales independientes: chat-helpers.js y
// anthropic.js, cada uno con su propio `= 4`. Un mutation test bajo la ruta Anthropic de 4
// a 2 dejaba las 889 pruebas en verde: media entrega de imagenes menos, cero senal. Ahora
// la constante es una sola y se exporta; estas pruebas son las que lo notan.
//
// El guardian de verdad NO es comparar numeros —— eso seguiria pasando si un barrido
// dejara de respetar su tope. Es meter UNA entrada por los DOS barridos y exigir la misma
// salida. Las URLs son https:// para que todo esto sea sin red: normalizeMediaContentItem
// vuelve temprano y no hace falta cuenta ni subida.

const TOOLS = [{
  name: 'Read',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}];

const url = (i) => `https://example.invalid/img${i}.png`;
const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Un turno con `count` imagenes pegadas, cada una en su propio mensaje de usuario, y una
 * ultima linea de texto detras.
 *
 * Es la forma exacta que manda Claude Code al pegar capturas: `[text, image]` seguido de
 * un mensaje meta solo-texto (`[Image: source: …png]`), asi que ninguna imagen queda en la
 * ultima posicion. Es ademas la unica forma que los DOS barridos tratan igual: las imagenes
 * viajan como items de `content[]`, no por el bypass `.media` que solo existe en la ruta
 * Anthropic. Por eso sirve de entrada comun.
 */
const pastedTurn = (count) => {
  const messages = [];
  for (let i = 1; i <= count; i++) {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `image ${i}` }, { type: 'image', source: { type: 'url', url: url(i) } }]
    });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: '[Image: source: pasted.png]' }] });
  return messages;
};

/** Lo que entrega el barrido OpenAI, en URLs. */
const openaiScanUrls = (anthropicMessages) =>
  harvestCurrentTurnMedia(flattenAnthropicMessages(clone(anthropicMessages)))
    .map(item => item?.image_url?.url);

/** Lo que entrega el barrido Anthropic, extremo a extremo, en URLs. */
const anthropicScanUrls = async (anthropicMessages) => {
  const { body } = await buildInternalRequest({
    model: 'qwen3.8-max', max_tokens: 256, messages: clone(anthropicMessages), tools: TOOLS
  });
  return (body.messages[0].files || []).filter(f => f.type === 'image').map(f => f.url);
};

describe('HARVEST_MEDIA_CAP: los dos barridos son un solo barrido', () => {
  it('una sola entrada por los dos barridos rinde exactamente la misma entrega, por encima del tope', async () => {
    // El caso que el mutante sobrevivia: mas medios que el tope. Por debajo del tope los
    // dos barridos entregan todo y un tope divergente no se nota; aqui si.
    const messages = pastedTurn(HARVEST_MEDIA_CAP + 2);
    const viaOpenai = openaiScanUrls(messages);
    const viaAnthropic = await anthropicScanUrls(messages);

    assert.deepEqual(viaAnthropic, viaOpenai,
      'los barridos gemelos entregaron medios distintos para la misma entrada:\n' +
      `  anthropic.js#buildInternalRequest -> ${JSON.stringify(viaAnthropic)}\n` +
      `  chat-helpers.js#harvestCurrentTurnMedia -> ${JSON.stringify(viaOpenai)}`);

    // Y la salida comun tiene que ser la que dicta el tope, no cualquier cosa igual en los
    // dos lados: si un barrido dejara de respetarlo y el otro tambien, deepEqual pasaria.
    assert.equal(viaAnthropic.length, HARVEST_MEDIA_CAP,
      `el tope por turno es ${HARVEST_MEDIA_CAP} y se entregaron ${viaAnthropic.length}`);
    // Se barre hacia atras: lo que sobrevive al corte son los medios MAS NUEVOS.
    assert.deepEqual(viaAnthropic, [url(3), url(4), url(5), url(6)]);
  });

  it('por debajo del tope los dos entregan todo, asi que la igualdad de arriba no es vacia', async () => {
    const messages = pastedTurn(HARVEST_MEDIA_CAP - 1);
    const viaOpenai = openaiScanUrls(messages);
    const viaAnthropic = await anthropicScanUrls(messages);

    assert.equal(viaOpenai.length, HARVEST_MEDIA_CAP - 1, 'sin corte, el barrido OpenAI entrega todo');
    assert.deepEqual(viaAnthropic, viaOpenai);
  });

  it('el tope es UN literal, exportado desde chat-helpers.js', () => {
    assert.equal(typeof HARVEST_MEDIA_CAP, 'number');
    assert.ok(HARVEST_MEDIA_CAP > 0);
    // Redeclararlo en anthropic.js es justo la regresion que dejo pasar el mutante: dos
    // literales que nada relaciona. Que lo importe, no que lo repita.
    const source = fs.readFileSync(path.join(__dirname, '../src/controllers/anthropic.js'), 'utf8');
    assert.ok(!/HARVEST_MEDIA_CAP\s*=\s*[0-9]/.test(source),
      'anthropic.js volvio a declarar su propio HARVEST_MEDIA_CAP: importalo de chat-helpers.js');
  });

  it('4 es una decision de capacidad: cambiarlo es deliberado y se actualiza aqui', () => {
    // Sin esta linea, mover el tope compartido no falla ninguna prueba. Con ella, mover
    // el tope obliga a decir por que. La forma que lo necesitaria (una historia entera sin
    // frontera de turno) no aparece en ninguna captura real: es un seguro, no un registro
    // de accidente.
    assert.equal(HARVEST_MEDIA_CAP, 4);
  });
});

describe('HARVEST_MEDIA_CAP: el desacuerdo conocido de anthropic.js:390', () => {
  // La nota del codigo dice: el tope corta el RECORRIDO, asi que un turno con mas de
  // HARVEST_MEDIA_CAP medios puede tener un resultado DENTRO de la ventana cuyo medio no
  // llega a visitarse. `delivered` en la nota se decide por POSICION
  // (flattenAnthropicMessages, via currentTurnStartIndex) y el corte ocurre despues, en el
  // barrido: los dos no se hablan.
  //
  // Estaba documentado y sin probar. Esto lo clava tal cual esta HOY, sin cambiar nada de
  // comportamiento. Es un pin de un agujero conocido, no una afirmacion de que este bien:
  // si alguien lo arregla (hacer que la nota mire la entrega real, o repartir el tope
  // sobre el recorrido), esta prueba falla y hay que reescribirla — que es exactamente lo
  // que se quiere que pase, en vez de que el arreglo pase inadvertido.
  const readLoop = (count) => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'read the images' }] }];
    for (let i = 1; i <= count; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `toolu_0${i}`, name: 'Read', input: { path: `img${i}.png` } }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_0${i}`, content: [{ type: 'image', source: { type: 'url', url: url(i) } }] }] });
    }
    return messages;
  };

  it('por encima del tope, la nota positiva deja de implicar entrega — y esto NO esta arreglado', async () => {
    const count = HARVEST_MEDIA_CAP + 2;
    const { body } = await buildInternalRequest({
      model: 'qwen3.8-max', max_tokens: 256, messages: readLoop(count), tools: TOOLS
    });
    const content = body.messages[0].content;
    const files = (body.messages[0].files || []).filter(f => f.type === 'image');
    const positive = (content.match(/\[1 image returned by this tool\]/g) || []).length;
    const negative = (content.match(/\[1 image returned by this tool, not included in this request\]/g) || []).length;

    // Los `count` resultados estan en el turno en curso, asi que los `count` reciben la
    // nota POSITIVA...
    assert.equal(positive, count, 'la nota se decide por posicion: todos los del turno son positivos');
    assert.equal(negative, 0);
    // ...pero solo `HARVEST_MEDIA_CAP` medios se visitan y viajan.
    assert.equal(files.length, HARVEST_MEDIA_CAP);
    // Ese es el desacuerdo, dicho en numeros: 2 notas prometen una imagen que no viaja.
    assert.equal(positive - files.length, count - HARVEST_MEDIA_CAP,
      'anthropic.js:390 describe exactamente esta diferencia; si cambia, actualiza la nota Y esta prueba');
  });

  it('hasta el tope no hay desacuerdo: nota positiva <=> imagen en files[]', async () => {
    const { body } = await buildInternalRequest({
      model: 'qwen3.8-max', max_tokens: 256, messages: readLoop(HARVEST_MEDIA_CAP), tools: TOOLS
    });
    const content = body.messages[0].content;
    const files = (body.messages[0].files || []).filter(f => f.type === 'image');
    const positive = (content.match(/\[1 image returned by this tool\]/g) || []).length;
    assert.equal(files.length, HARVEST_MEDIA_CAP);
    assert.equal(positive, HARVEST_MEDIA_CAP, 'dentro del tope las dos reglas coinciden');
  });
});
