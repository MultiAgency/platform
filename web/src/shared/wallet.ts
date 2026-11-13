import type { Intent } from "@near-intents-agent-api/sdk";
import { type DataStorage, NearConnector } from "@fastnear/near-connect";
import { useSyncExternalStore } from "react";

type WalletState = { status: "idle" | "connecting" | "connected"; accountId?: string; publicKey?: string };
export type Transaction = {
  receiverId: string;
  actions: (
    | { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }
    | { type: "Transfer"; params: { deposit: string } }
  )[];
};

/**
 * One wallet connection as an external store: its account, connect and disconnect, and sending
 * a transaction as that account.
 */
function walletSession(createConnector: () => NearConnector, walletId?: string) {
  let instance: NearConnector | undefined;
  const connector = () => {
    if (!instance) {
      instance = createConnector();
      instance.on("wallet:signIn", sync);
      instance.on("wallet:signOut", () => update({ status: "idle" }));
      void sync();
    }
    return instance;
  };
  let state: WalletState = { status: "idle" };
  const listeners = new Set<() => void>();
  const update = (next: WalletState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const sync = async () => {
    try {
      const [account] = (await connector().getConnectedWallet()).accounts;
      update(account ? { status: "connected", ...account } : { status: "idle" });
    } catch {
      update({ status: "idle" });
    }
  };

  return {
    get connector() { return connector(); },
    update,
    use: () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          connector();
          return () => listeners.delete(listener);
        },
        () => state,
      ),
    async connect() {
      update({ status: "connecting" });
      try {
        await connector().connect(walletId ? { walletId } : undefined);
      } finally {
        await sync();
      }
    },
    async disconnect() {
      await connector().disconnect();
      update({ status: "idle" });
    },
    /** Sends `transaction` as the connected account. Through Trezu that files it as a DAO proposal. */
    async send(transaction: Transaction) {
      const { wallet, accounts } = await connector().getConnectedWallet();
      const signerId = accounts[0]?.accountId;
      if (!signerId) throw new Error("Connect a wallet first");
      return wallet.signAndSendTransaction({ signerId, ...transaction });
    },
  };
}

/**
 * HOT's near-connect wallet list, read when that wallet session is first used. It declares delegate actions for more
 * wallets than FastNear's (HOT, Ledger and NEAR Mobile besides Meteor and Intear), and it lists Trezu.
 * Not pinned: each wallet's own code loads from addresses that change anyway (a branch, the wallet's
 * site), so a pinned list would freeze little.
 */
const HOT_WALLETS = "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json";

/**
 * The owner's wallet. Owner actions need both NEAR signatures (NEP-413 messages for grants,
 * NEP-366 delegate actions for creating and freezing), so only wallets offering both are listed.
 */
const owner = walletSession(
  () => new NearConnector({ network: "mainnet", manifest: HOT_WALLETS, features: { signMessage: true, signDelegateActions: true } }),
);

/** Keeps each connection's session apart from the owner's in the same browser. */
const namespaced = (prefix: string): DataStorage => ({
  get: async (key) => localStorage.getItem(`${prefix}:${key}`),
  set: async (key, value) => localStorage.setItem(`${prefix}:${key}`, value),
  remove: async (key) => localStorage.removeItem(`${prefix}:${key}`),
});

/**
 * A DAO acting through Trezu, a second connection beside the owner's: it signs as the DAO by
 * filing each transaction as a proposal its members vote on.
 */
export const dao = walletSession(
  () => new NearConnector({
    network: "mainnet",
    manifest: HOT_WALLETS,
    storage: namespaced("dao"),
  }),
  "trezu-wallet",
);

export const useWallet = owner.use;

/** A member signing in to the hosted dashboard: a NEP-413 signature is all it needs. */
const member = walletSession(() => new NearConnector({ network: "mainnet", features: { signMessage: true }, storage: namespaced("member") }));

/** Signs the gateway's sign-in challenge with the member's wallet, connecting first. */
export async function signChallenge({ message, recipient, nonce }: { message: string; recipient: string; nonce: string }) {
  if ((await member.connector.getConnectedWallet().catch(() => null))?.accounts.length !== 1) await member.connect();
  const { wallet } = await member.connector.getConnectedWallet();
  const signed = await wallet.signMessage({ message, recipient, nonce: fromBase64(nonce) });
  // Some wallets also sign the page that asked as a callback URL, without saying so: offer the candidates.
  const callbackUrls = [...new Set([`${location.origin}/`, location.href])];
  return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce, callbackUrls };
}

export const signOutMember = () => member.disconnect();

/**
 * A wallet owner's own stop (the confirm build's stop page): one NEP-413 signature is all it needs, so every wallet
 * that signs messages is offered, not only those that also sign delegate actions. Its session is apart from the owner's.
 */
const stopper = walletSession(() => new NearConnector({ network: "mainnet", manifest: HOT_WALLETS, features: { signMessage: true }, storage: namespaced("stop") }));
export const useStopWallet = stopper.use;
export const connectStopWallet = () => stopper.connect();
/** Signs the stop's text with the stop page's wallet, unchanged, for `recipient`. */
export async function signStopMessage({ message, recipient, nonce }: { message: string; recipient: string; nonce: string }) {
  const { wallet } = await stopper.connector.getConnectedWallet();
  const signed = await wallet.signMessage({ message, recipient, nonce: fromBase64(nonce) });
  return { publicKey: signed.publicKey, signature: signed.signature };
}

/**
 * Signs the provider's intent for a freeze the stop prepared, with the stop page's wallet, exactly as generated. A NEP-366
 * intent needs a wallet that signs delegate actions, which a message-only wallet the page also lists doesn't.
 */
export async function signStopIntent(intent: Intent) {
  const { wallet } = await stopper.connector.getConnectedWallet();
  if (intent.standard === "nep366" && !wallet.manifest.features?.signDelegateActions)
    throw new Error("This wallet doesn't sign delegate actions (NEP-366), which the provider's freeze is. Connect the owner's account with a wallet that does, then sign the freeze.");
  return signWith(wallet, intent);
}
/** Connects another wallet on the stop page, for a freeze the first one can't sign. */
export async function switchStopWallet() {
  await stopper.disconnect().catch(() => undefined);
  await stopper.connect();
}

/** Sends a transaction from the signed-in member's own wallet, such as a DAO proposal they file. */
export const sendAsMember = (transaction: Transaction) => member.send(transaction);
export const connect = () => owner.connect();
export const disconnect = () => owner.disconnect();
export const send = (transaction: Transaction) => owner.send(transaction);

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/**
 * The connected account as an agent owner. Some wallets report the key only with a signature,
 * so a missing key is read from a one-off signed message.
 */
export async function ownerWallet() {
  const { wallet, accounts } = await owner.connector.getConnectedWallet();
  const [account] = accounts;
  if (!account) throw new Error("Connect a wallet first");
  const publicKey =
    account.publicKey ??
    (
      await wallet.signMessage({
        message: "Identify my key as the owner of an Agentic Treasury agent",
        recipient: location.host,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
      })
    ).publicKey;
  owner.update({ status: "connected", accountId: account.accountId, publicKey });
  return { type: "near" as const, account_id: account.accountId, public_key: publicKey };
}

/** Signs an owner intent's payload exactly as the API generated it, by the standard it chose. */
export async function signIntent(intent: Intent): Promise<Record<string, unknown>> {
  return signWith((await owner.connector.getConnectedWallet()).wallet, intent);
}

type ConnectedWallet = Awaited<ReturnType<NearConnector["getConnectedWallet"]>>["wallet"];
async function signWith(wallet: ConnectedWallet, intent: Intent): Promise<Record<string, unknown>> {
  switch (intent.standard) {
    case "nep413": {
      const { publicKey, signature } = await wallet.signMessage({ ...intent.payload, nonce: fromBase64(intent.payload.nonce) });
      return { ...intent, public_key: publicKey, signature };
    }
    case "nep366": {
      const { signedDelegateActions } = await wallet.signDelegateActions({ delegateActions: [intent.payload] });
      const signed = signedDelegateActions[0];
      // Wallets answer in one of two transport forms; an older object form has no stable encoding.
      if (typeof signed === "string") return { ...intent, signed_delegate: signed };
      if (signed && "borshSerializedBase64" in signed) return { ...intent, signed_delegate: signed.borshSerializedBase64 };
      throw new Error("This wallet returned its signature in an older format. Try another wallet.");
    }
    default:
      throw new Error(`This dashboard signs NEAR intents only, not ${intent.standard}`);
  }
}
