"""材质agent 配置加载。"""
import json
import os

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(PKG_DIR)
MODELS = os.path.abspath(os.environ.get('TWIN_MODELS_DIR') or os.path.join(BASE_DIR, 'models'))

DEFAULTS = {
    'tencent_key': '',
    'amap_key': '',
    'mapillary_token': '',
    'glm_key': '',
    'mapillary_proxy': None,
    'glm_model': 'glm-4v-flash',
    'critique_votes': 3,
    'min_luma': 45,
    'sd_dir': os.path.join(MODELS, 'AI-ModelScope--realistic-vision-v51', 'snapshots', 'master'),
    'cn_canny': os.path.join(MODELS, 'lllyasviel--control_v11p_sd15_canny', 'snapshots', 'master'),
    'cn_depth': os.path.join(MODELS, 'lllyasviel--control_v11f1p_sd15_depth', 'snapshots', 'master'),
    'ipa_dir': os.path.join(MODELS, 'AI-ModelScope--IP-Adapter', 'snapshots', 'master'),
    'ipa_weight': 'ip-adapter_sd15.bin',
    'runs_dir': os.path.join(BASE_DIR, 'runs'),
    'logs_dir': os.path.join(BASE_DIR, 'logs'),
    'fallback_ref': None,
}

ENV_KEYS = {
    'tencent_key': 'TENCENT_KEY',
    'amap_key': 'AMAP_KEY',
    'mapillary_token': 'MAPILLARY_TOKEN',
    'glm_key': 'GLM_KEY',
    'mapillary_proxy': 'MAPILLARY_PROXY',
}


def load_config(path=None):
    cfg = dict(DEFAULTS)
    p = path or os.environ.get('MATERIAL_AGENT_CONFIG') or os.path.join(BASE_DIR, 'config.local.json')
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            cfg.update(json.load(f))
    for key, env in ENV_KEYS.items():
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    cfg['config_path'] = p
    return cfg
