import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Inbox, Loader2, X, type LucideIcon } from 'lucide-react';

export function Button({ variant = 'secondary', busy = false, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }) {
  return (
    <button type="button" {...props} className={`btn btn-${variant} ${props.className ?? ''}`} disabled={props.disabled || busy} aria-busy={busy || undefined}>
      {busy && <Loader2 className="spin" size={16} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: 'blue' | 'green' | 'amber' | 'red' | 'gray' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function EmptyState({ icon: Icon = Inbox, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon size={28} aria-hidden="true" />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'warning' | 'success' | 'info'; children: ReactNode }) {
  if (!children) return null;
  return <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner" role="status"><Loader2 className="spin" size={20} aria-hidden="true" /> {label}…</div>;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label="Pages">
      <Button variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} of {pages}</span>
      <Button variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </nav>
  );
}

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (ref.current?.querySelector<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]),select,textarea') ?? ref.current?.querySelector<HTMLElement>('button'))?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab' || !ref.current) return;
      const nodes = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])')];
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', listener);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', listener); previous?.focus(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header className="modal-header">
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Connection state shown on every screen: staff must know whether what they see is current. */
export function ConnectionBar({ state, lastRefresh, timezone }: { state: 'online' | 'refreshing' | 'offline'; lastRefresh: string | null; timezone: string }) {
  const time = lastRefresh ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(lastRefresh)) : 'never';
  return (
    <div className={`connection connection-${state}`} role="status">
      <span className="connection-dot" aria-hidden="true" />
      {state === 'offline'
        ? <>Offline. Showing data from {time}. Follow the outage procedure and record times on paper until the connection returns.</>
        : <>{state === 'refreshing' ? 'Refreshing…' : 'Connected.'} Last updated {time}.</>}
    </div>
  );
}
