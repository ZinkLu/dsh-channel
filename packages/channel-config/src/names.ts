/**
 * Single source of truth for provider settings namespaces and credential refs.
 * Plain strings only — the host side brands namespaces with
 * `settingsNamespace()` and wraps credential refs with `credentialRef()`, so
 * this package stays free of any dsh runtime dependency and can be reused by
 * browser bundles later.
 */

/** Settings namespaces, one per provider instance. */
export const CHANNEL_TELEGRAM_NS = 'channel-telegram'
export const CHANNEL_WECHAT_NS = 'channel-wechat'
export const CHANNEL_FEISHU_NS = 'channel-feishu'

/** Credential references resolved through `ctx.credentials`. */
export const CREDENTIAL_TELEGRAM_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN'
export const CREDENTIAL_WECHAT_TOKEN = 'WECHAT_TOKEN'
export const CREDENTIAL_WECHAT_ACCOUNT_ID = 'WECHAT_ACCOUNT_ID'
export const CREDENTIAL_FEISHU_APP_ID = 'FEISHU_APP_ID'
export const CREDENTIAL_FEISHU_APP_SECRET = 'FEISHU_APP_SECRET'
