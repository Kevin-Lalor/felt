import { useState } from 'react';
import { connectAndJoin } from '../socket';
import { useStore } from '../store';

export const AVATARS = ['🦊', '🐻', '🦉', '🐸', '🐺', '🦈', '🃏', '🎩'];

export function Join() {
  const lastError = useStore((s) => s.lastError);
  const [name, setName] = useState(localStorage.getItem('felt.name') ?? '');
  const [code, setCode] = useState(
    new URLSearchParams(location.search).get('invite') ?? localStorage.getItem('felt.invite') ?? '',
  );
  const [avatar, setAvatar] = useState(Number(localStorage.getItem('felt.avatar') ?? 0));

  const ready = name.trim().length > 0 && code.trim().length > 0;
  const submit = () => {
    if (!ready) return;
    localStorage.setItem('felt.name', name.trim());
    localStorage.setItem('felt.invite', code.trim());
    localStorage.setItem('felt.avatar', String(avatar));
    connectAndJoin({ inviteCode: code.trim(), name: name.trim(), avatar });
  };

  return (
    <div className="join">
      <header className="join__brand">
        <span className="join__logo">♠</span>
        <span className="join__wordmark">FELT</span>
      </header>
      <h1 className="join__headline">Your Friday game. Minus the folding table.</h1>
      <p className="join__sub">Play chips only. Nine seats. Nothing to download.</p>

      <div className="join__form">
        <label className="join__label" htmlFor="join-code">
          TABLE CODE — got a code from a friend? That&rsquo;s the whole login.
        </label>
        <input
          id="join-code"
          className="join__input join__input--code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABC123"
          autoComplete="off"
          maxLength={16}
        />

        <label className="join__label" htmlFor="join-name">
          NAME AT THIS TABLE
        </label>
        <input
          id="join-name"
          className="join__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Donk Kong"
          maxLength={16}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />

        <span className="join__label">PICK A FACE</span>
        <div className="join__avatars" role="radiogroup" aria-label="avatar">
          {AVATARS.map((a, i) => (
            <button
              key={a}
              role="radio"
              aria-checked={avatar === i}
              className={`join__avatar${avatar === i ? ' join__avatar--on' : ''}`}
              onClick={() => setAvatar(i)}
            >
              {a}
            </button>
          ))}
        </div>

        <button className="btn btn--accent join__cta" disabled={!ready} onClick={submit}>
          Pull up a chair
        </button>
        {lastError && <p className="join__error">{lastError.message}</p>}
      </div>
      <footer className="join__footer">PLAY CHIPS ONLY · NO CASH VALUE · PROVABLY FAIR SHUFFLE</footer>
    </div>
  );
}
