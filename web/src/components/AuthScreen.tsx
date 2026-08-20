import { motion } from 'framer-motion';
import { LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { LOCALES } from '../i18n';
import type { Locale } from '../lib/types';
import { useAuth } from '../store/auth';
import { useTranslation, useUi } from '../store/ui';
import { AuroraBackground } from './AuroraBackground';
import { Spinner } from './ui';

export function AuthScreen() {
  const { dict, locale } = useTranslation();
  const setLocale = useUi((s) => s.setLocale);
  const { signIn, signUp, busy, error, clearError } = useAuth();

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    clearError();
    if (mode === 'signin') await signIn(email, password);
    else await signUp(email, password, name || email.split('@')[0]);
  };

  return (
    <div className="auth">
      <AuroraBackground />

      <motion.div
        className="auth__card glass"
        initial={{ opacity: 0, y: 30, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 24 }}
      >
        <div className="auth__brand">
          <span className="auth__logo">◈</span>
          <div>
            <h1 className="auth__name">{dict.app.name}</h1>
            <p className="muted">{dict.app.tagline}</p>
          </div>
        </div>

        <div className="auth__locales">
          {LOCALES.map((meta) => (
            <button
              key={meta.code}
              className={`chip chip--action ${locale === meta.code ? 'is-active' : ''}`}
              onClick={() => setLocale(meta.code as Locale)}
            >
              {meta.flag} {meta.native}
            </button>
          ))}
        </div>

        <h2 className="auth__title">{mode === 'signin' ? dict.auth.signInTitle : dict.auth.signUpTitle}</h2>

        <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
          {mode === 'signup' && (
            <div className="field">
              <label htmlFor="auth-name">{dict.auth.name}</label>
              <input
                id="auth-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="auth-email">{dict.auth.email}</label>
            <input
              id="auth-email"
              type="email"
              required
              className="input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label htmlFor="auth-password">{dict.auth.password}</label>
            <input
              id="auth-password"
              type="password"
              required
              minLength={8}
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
            {mode === 'signup' && <p className="faint">{dict.auth.passwordHint}</p>}
          </div>

          {error && (
            <motion.p className="auth__error" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}>
              {error}
            </motion.p>
          )}

          <button className="btn btn-primary auth__submit" type="submit" disabled={busy}>
            {busy ? <Spinner size={16} /> : mode === 'signin' ? <LogIn size={16} /> : <UserPlus size={16} />}
            {mode === 'signin' ? dict.auth.signIn : dict.auth.signUp}
          </button>
        </form>

        <button
          className="btn btn-ghost auth__switch"
          onClick={() => {
            clearError();
            setMode(mode === 'signin' ? 'signup' : 'signin');
          }}
        >
          {mode === 'signin' ? dict.auth.noAccount : dict.auth.hasAccount}{' '}
          <strong>{mode === 'signin' ? dict.auth.signUp : dict.auth.signIn}</strong>
        </button>

        <p className="auth__note faint">
          <ShieldCheck size={13} /> {dict.auth.demoHint}
        </p>
      </motion.div>
    </div>
  );
}
