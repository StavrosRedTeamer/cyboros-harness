// local/grammar.js — costruttore di grammatica GBNF per l'edizione locale.
// Vincola l'output del modello DEBOLE a UNA di due forme, per turno:
//   ACTION: {"tool":"<uno dei tool ammessi>","args":{...json valido...}}
//   FINAL: <testo libero>
// Così ogni turno è SEMPRE parsabile (niente JSON rotto, niente nome-tool inventato):
// il collo di bottiglia del tool-calling su un ~3B-attivi sparisce senza addestrare nulla.
//
// llama.cpp accetta il campo `grammar` (GBNF) nel body di /v1/chat/completions.
// Il valore degli `args` resta JSON generico: la validazione fine la fa il dispatch.

'use strict';

// Frammento JSON canonico (adattato da grammars/json.gbnf di llama.cpp).
const JSON_CORE = `
value  ::= object | array | string | number | ("true" | "false" | "null") ws
object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws
array  ::= "[" ws ( value ("," ws value)* )? "]" ws
string ::= "\\"" ( [^"\\\\] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]) )* "\\"" ws
number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)? ws
ws     ::= [ \\t\\n]*
`;

// Escape di un nome-tool per inserirlo come terminale GBNF che matcha  "nome"  (con le
// virgolette JSON incluse). I nomi dei tool sono [a-z_], quindi niente escaping speciale.
function toolTerminal(name) {
  return `"\\"${name}\\""`;
}

// Costruisce la grammatica per l'insieme di tool ammessi in questa fase.
// allowThinking: se true, consente un blocco <think>...</think> iniziale (modelli reasoning).
function toolProtocolGrammar(toolNames, { allowThinking = false } = {}) {
  const names = (toolNames && toolNames.length) ? toolNames : ['read_file'];
  const toolRule = names.map(toolTerminal).join(' | ');
  const think = allowThinking ? 'think? ' : '';
  const thinkRule = allowThinking
    ? '\nthink   ::= "<think>" ( [^<] | "<" [^/] )* "</think>" ws'
    : '';
  return `# StavrosRedTeamer edizione locale — protocollo tool vincolato
root    ::= ws ${think}( action | final )
action  ::= "ACTION:" ws "{" ws "\\"tool\\"" ws ":" ws toolname ws "," ws "\\"args\\"" ws ":" ws value ws "}" ws
final   ::= "FINAL:" ws freetext
toolname ::= ${toolRule}
freetext ::= ( [^\\u0000] )*
${JSON_CORE}${thinkRule}
`;
}

module.exports = { toolProtocolGrammar };
