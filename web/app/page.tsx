"use client";

import { FormEvent, useEffect, useMemo, useState } from 'react';

type Message = {
  id?: number;
  message_id: string;
  sender_id: string;
  sender_wallet?: string;
  price: number;
  status: string;
  created_at: number;
};

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function Home() {
  const [walletAddress, setWalletAddress] = useState('0x1111111111111111111111111111111111111111');
  const [email, setEmail] = useState('alice@mmp.local');
  const [phone, setPhone] = useState('+15550001111');
  const [handle, setHandle] = useState('alice');
  const [userId, setUserId] = useState('');

  const [balance, setBalance] = useState(0);
  const [topup, setTopup] = useState(500);

  const [recipient, setRecipient] = useState('bob');
  const [message, setMessage] = useState('This is a paid inbox message');
  const [messages, setMessages] = useState<Message[]>([]);

  const [code, setCode] = useState('');
  const [verifyTarget, setVerifyTarget] = useState('phone');
  const [authToken, setAuthToken] = useState('');

  const [channelHandle, setChannelHandle] = useState('');
  const [channelSecret, setChannelSecret] = useState('');

  const authHeaders = (includeContentType = true) => {
    const headers: Record<string, string> = {};
    if (includeContentType) {
      headers['content-type'] = 'application/json';
    }
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    return headers;
  };

  useEffect(() => {
    if (!userId) return;
    refreshInbox();
  }, [userId]);

  const register = async (e: FormEvent) => {
    e.preventDefault();
    const res = await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletAddress, email, phone, handle }),
    });
    const data = await res.json();
    if (data.user?.id) {
      setUserId(data.user.id);
      setBalance(Number(data.user.balance || 0));
      setAuthToken(data.token || '');
    }
  };

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    const res = await fetch(`${API}/v1/verify/request`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId, channel: verifyTarget, target: verifyTarget === 'phone' ? phone : email }),
    });
    const data = await res.json();
    setCode(data.code || '');
  };

  const confirm = async () => {
    if (!userId) return;
    await fetch(`${API}/v1/verify/confirm`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId, channel: verifyTarget, target: verifyTarget === 'phone' ? phone : email, code }),
    });
  };

  const savePricing = async () => {
    if (!userId) return;
    await fetch(`${API}/v1/pricing`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ userId, defaultPrice: 200, firstContactPrice: 500, returnDiscountBps: 500, acceptsAll: true }),
    });
  };

  const topUp = async () => {
    if (!userId) return;
    const res = await fetch(`${API}/v1/payments/topup`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId, amount: topup }),
    });
    const data = await res.json();
    setBalance(Number(data.balance));
  };

  const sendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    await fetch(`${API}/v1/messages/send`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ senderId: userId, recipientSelector: recipient, plaintext: message }),
    });
    refreshInbox();
  };

  const refreshInbox = async () => {
    if (!userId) return;
    if (!authToken) {
      return;
    }

    const res = await fetch(`${API}/v1/messages/inbox/${userId}`, {
      headers: authHeaders(false),
    });
    const data = await res.json();
    setMessages(data.messages || []);
  };

  const connectChannel = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    await fetch(`${API}/v1/channels/telegram/connect`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId, externalHandle: channelHandle, secret: channelSecret, consentVersion: 'v1' }),
    });
  };

  const discover = async (e: FormEvent) => {
    e.preventDefault();
    const res = await fetch(`${API}/v1/recipient/${recipient}`);
    const data = await res.json();
    if (!res.ok) return;
    alert(`Recipient: ${data.handle || recipient}. Message price: ${data.pricing.defaultPrice} / ${data.pricing.firstContactPrice}`);
  };

  const profileSummary = useMemo(() => {
    return {
      walletAddress,
      userId,
      handle,
      balance,
    };
  }, [walletAddress, userId, handle, balance]);

  return (
    <section className="panel-grid">
      <article className="panel">
        <h1>Recipient onboarding</h1>
        <form onSubmit={register}>
          <label>
            Wallet
            <input value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} />
          </label>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Phone
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            Handle
            <input value={handle} onChange={(e) => setHandle(e.target.value)} />
          </label>
          <button type="submit">Create account</button>
        </form>
        <p>Current user {profileSummary.userId ? `${profileSummary.handle} (${profileSummary.walletAddress})` : 'not created'}</p>
        <div className="balance">Balance: {profileSummary.balance}</div>
      </article>

      <article className="panel">
        <h1>Verification</h1>
        <form onSubmit={requestCode}>
          <label>
            Target
            <select value={verifyTarget} onChange={(e) => setVerifyTarget(e.target.value)}>
              <option value="phone">Phone</option>
              <option value="email">Email</option>
            </select>
          </label>
          <button>Request code</button>
        </form>
        <div className="spacer">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="OTP" />
          <button onClick={confirm}>Confirm verification</button>
        </div>
        <button onClick={savePricing}>Save pricing</button>
      </article>

      <article className="panel">
        <h1>Wallet and Top Up</h1>
        <label>
          Top up amount
          <input type="number" value={topup} onChange={(e) => setTopup(Number(e.target.value))} />
        </label>
        <button onClick={topUp}>Top up</button>
      </article>

      <article className="panel">
        <h1>Send paid message</h1>
        <form onSubmit={discover}>
          <label>
            Recipient
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="@handle or phone" />
          </label>
          <button>Check price</button>
        </form>
        <form onSubmit={sendMessage}>
          <label>
            Message
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <button>Send</button>
        </form>
      </article>

      <article className="panel">
        <h1>Channels</h1>
        <form onSubmit={connectChannel}>
          <label>
            Telegram handle
            <input value={channelHandle} onChange={(e) => setChannelHandle(e.target.value)} />
          </label>
          <label>
            Telegram secret
            <input value={channelSecret} onChange={(e) => setChannelSecret(e.target.value)} />
          </label>
          <button>Connect Telegram</button>
        </form>
      </article>

      <article className="panel full">
        <h1>Inbox</h1>
        <button onClick={refreshInbox}>Refresh</button>
        <ul>
          {messages.map((m) => (
            <li key={m.message_id}>
              {new Date(m.created_at).toLocaleString()} — from {m.sender_wallet} — paid {m.price} — {m.status}
            </li>
          ))}
        </ul>
      </article>
    </section>
  );
}
