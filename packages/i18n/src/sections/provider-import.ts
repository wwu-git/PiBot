export const providerImportZh = {
  "providerImport.title": "从 {name} 切换模型？",
  "providerImport.intro":
    "另一个应用（{name}）打开了一个链接，请 Pi Bot 改用它提供的模型。点「切换」之前不会改任何设置。",
  "providerImport.changes": "会改什么",
  "providerImport.provider": "来源",
  "providerImport.localGateway": "{name}（本机网关）",
  "providerImport.address": "地址",
  "providerImport.localAddress": "{url} · 本机，请求经 {name} 转发到你在 {name} 里配置的服务",
  "providerImport.model": "模型",
  "providerImport.key": "密钥",
  "providerImport.keyIncluded": "链接含密钥，将加密保存",
  "providerImport.noKey": "链接不含密钥",
  "providerImport.gatewayNoKey": "链接里没有密钥（{name} 不需要）",
  "providerImport.applyTo": "应用到",
  "providerImport.selectionNote": "点 Bot 切换；灰的不改，继续用原来的模型。",
  "providerImport.auditNote":
    "每次切换都会写进审计记录。以后想换回来，在 设置 › 模型 里改默认模型即可。",
  "providerImport.switch": "切换",
  "providerImport.refused": "已拒绝模型切换",
  "providerImport.refusedFrom": "已拒绝来自 {name} 的链接",
  "providerImport.refusedIntro": "这个链接没有被采用，设置没有改动。",
  "providerImport.refusedNote":
    "链接无效、没有可以切换的 Bot，或者地址不是 https、本机或局域网。如果确实要用这个服务，请在 设置 › 模型 里手动添加。",
  "providerImport.failed": "未能完成切换。请重新从来源应用打开链接后再试。",
  "providerImport.ok": "确定",
  "providerImport.gotIt": "知道了",
  "audit.providerImport.applied": "已通过链接切换 Bot 模型",
} as const;

export const providerImportEn: Record<keyof typeof providerImportZh, string> = {
  "providerImport.title": "Switch models from {name}?",
  "providerImport.intro":
    "Another app ({name}) opened a link asking Pi Bot to use a model it provides. Nothing changes until you choose Switch.",
  "providerImport.changes": "What changes",
  "providerImport.provider": "Source",
  "providerImport.localGateway": "{name} (local gateway)",
  "providerImport.address": "Address",
  "providerImport.localAddress":
    "{url} · this computer; {name} forwards requests to the services you set up in {name}",
  "providerImport.model": "Model",
  "providerImport.key": "API key",
  "providerImport.keyIncluded": "Included in the link and saved encrypted",
  "providerImport.noKey": "The link has no key",
  "providerImport.gatewayNoKey": "No key in the link ({name} does not need one)",
  "providerImport.applyTo": "Apply to",
  "providerImport.selectionNote": "Tap a Bot to switch it off; grey Bots keep their current model.",
  "providerImport.auditNote":
    "Every switch is written to the audit log. To switch back, change the default model in Settings › Models.",
  "providerImport.switch": "Switch",
  "providerImport.refused": "Model switch refused",
  "providerImport.refusedFrom": "Link from {name} refused",
  "providerImport.refusedIntro": "This link was not used and nothing changed.",
  "providerImport.refusedNote":
    "The link is invalid, no Bot can be switched, or the address is not https, this computer or the local network. To use this service anyway, add it yourself in Settings › Models.",
  "providerImport.failed":
    "The switch could not be completed. Reopen the link from the source app to try again.",
  "providerImport.ok": "OK",
  "providerImport.gotIt": "OK",
  "audit.providerImport.applied": "Bot models switched from a provider link",
};
