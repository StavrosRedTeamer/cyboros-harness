// evo-x2-lab — router njs per il gateway OpenAI-compatible
// Estrae il campo "model" dal body JSON e imposta $target_upstream,
// poi inoltra verso la named location @proxy.
// Alias coerenti con deploy/models.yaml.

const ALIASES = {
    // brain
    "brain":                      "brain",
    "qwen3.8-flash-next":         "brain",
    "qwen3.8-flash-next-heretic": "brain",
    "planner":                    "brain",
    "judge":                      "brain",
    // worker pool
    "coder":            "coder",
    "qwen3-coder-next": "coder",
    "generator":        "coder",
    "toolcaller":       "toolcaller",
    "gpt-oss-20b":      "toolcaller",
    "executor":         "toolcaller",
    "parser":           "parser",
    "qwen3.5-9b":       "parser",
    "cyber":            "cyber",
    "deep-hat-v2":      "cyber",
    "critic":           "cyber",
    "triage":           "triage",
    "cybersecqwen-4b":  "triage",
    "embed":            "embed",
    "bge-m3":           "embed",
    "rerank":           "rerank",
    "qwen3-reranker":   "rerank",
};

// ID esposti nel catalogo (njs non supporta lo spread su Set: elenco esplicito).
const CATALOG_IDS = [
    "brain", "coder", "toolcaller", "parser",
    "cyber", "triage", "embed", "rerank",
];

function catalog(r) {
    const data = CATALOG_IDS.map((id) => ({
        id: id,
        object: "model",
        owned_by: "evo-x2-lab",
    }));
    r.headersOut["Content-Type"] = "application/json";
    r.return(200, JSON.stringify({ object: "list", data: data }));
}

function route(r) {
    let model = null;
    try {
        const body = r.requestText || "";
        const match = body.match(/"model"\s*:\s*"([^"]+)"/);
        model = match ? match[1] : null;
    } catch (e) {
        r.error("router: body non leggibile: " + e);
    }

    const target = model ? (ALIASES[model.toLowerCase()] || null) : null;

    if (!target) {
        // Modello sconosciuto o assente: errore esplicito, non fallback silenzioso.
        // Un fallback al brain nasconderebbe i bug di routing nei log.
        r.headersOut["Content-Type"] = "application/json";
        r.return(400, JSON.stringify({
            error: {
                message: "model sconosciuto: " + (model || "(assente)") +
                         " — alias validi: /v1/models",
            },
        }));
        return;
    }

    r.variables.target_upstream = target;
    r.internalRedirect("@proxy");
}

export default { catalog, route };
