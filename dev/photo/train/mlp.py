"""Tiny numpy MLP (28 -> 64 -> 32 -> 8) shared by train/eval/export.

Matches js/photo/model.js exactly: W is stored row-major [out][in] per layer,
b is [out], ReLU hidden, softmax output.
"""
import json

import numpy as np

CLASSES = ['empty', 'black', 'white', 'red', 'blue', 'green', 'yellow', 'purple']
FORMAT = 'hexago-photo-mlp-v1'


def init_params(rng, sizes=(28, 64, 32, 8), scale=None):
    """He-initialised parameters as a list of dicts {W:(out,in), b:(out,)}."""
    params = []
    for i in range(len(sizes) - 1):
        ni, no = sizes[i], sizes[i + 1]
        s = scale if scale is not None else np.sqrt(2.0 / ni)
        params.append({
            'W': (rng.standard_normal((no, ni)) * s).astype(np.float32),
            'b': np.zeros(no, dtype=np.float32),
        })
    return params


def forward(params, X):
    """Return (logits, cache) for a batch X (N,28)."""
    a = np.asarray(X, dtype=np.float64)
    cache = [a]
    for i, p in enumerate(params):
        z = a @ p['W'].astype(np.float64).T + p['b'].astype(np.float64)
        if i < len(params) - 1:
            a = np.maximum(z, 0.0)
        else:
            a = z
        cache.append(a)
    return a, cache


def softmax(z):
    z = np.asarray(z, dtype=np.float64)
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def predict_proba(params, X, batch=8192):
    out = []
    for i in range(0, len(X), batch):
        logits, _ = forward(params, X[i:i + batch])
        out.append(softmax(logits))
    return np.concatenate(out, axis=0)


def predict(params, X, batch=8192):
    return predict_proba(params, X, batch).argmax(axis=1)


def save_model(params, path):
    layers = []
    for p in params:
        W = np.asarray(p['W'], dtype=np.float32)
        b = np.asarray(p['b'], dtype=np.float32)
        layers.append({
            'W': W.tolist(),
            'b': b.tolist(),
        })
    obj = {
        'format': FORMAT,
        'trained': True,
        'features': int(params[0]['W'].shape[1]),
        'classes': CLASSES,
        'layers': layers,
    }
    with open(path, 'w') as f:
        json.dump(obj, f, separators=(',', ':'))
    return obj


def load_model(path):
    with open(path) as f:
        obj = json.load(f)
    if obj.get('format') != FORMAT:
        raise ValueError('unsupported model format %r' % obj.get('format'))
    params = [{
        'W': np.asarray(layer['W'], dtype=np.float32),
        'b': np.asarray(layer['b'], dtype=np.float32),
    } for layer in obj['layers']]
    return params, obj.get('classes', CLASSES)


def fold_standardisation(params, mu, sd):
    """Fold feature standardisation (x-mu)/sd into the first layer, in place.

    z = W1 ((x - mu)/sd) + b1  ==  (W1/sd) x + (b1 - (W1/sd) mu)
    """
    W0 = params[0]['W'].astype(np.float64).copy()
    b0 = params[0]['b'].astype(np.float64).copy()
    sd = np.asarray(sd, dtype=np.float64)
    mu = np.asarray(mu, dtype=np.float64)
    params[0]['W'] = (W0 / sd[None, :]).astype(np.float32)
    params[0]['b'] = (b0 - (W0 / sd[None, :]) @ mu).astype(np.float32)
    return params


def confusion(y_true, y_pred, n_classes=8):
    cm = np.zeros((n_classes, n_classes), dtype=np.int64)
    for t, p in zip(y_true, y_pred):
        cm[int(t), int(p)] += 1
    return cm


def per_class_accuracy(cm):
    out = {}
    for c in range(cm.shape[0]):
        tot = cm[c].sum()
        out[CLASSES[c]] = (float(cm[c, c]) / tot) if tot else None
    return out


def accuracy(y_true, y_pred):
    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred)
    return float((y_true == y_pred).mean()) if len(y_true) else float('nan')
