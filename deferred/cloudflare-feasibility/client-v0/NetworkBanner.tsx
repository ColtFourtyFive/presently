import { RefreshCw, WifiOff } from 'lucide-react';

export type ConnectionState = 'connected' | 'refreshing' | 'disconnected';

export default function NetworkBanner({ state, lastRefresh, onRetry }: { state: ConnectionState; lastRefresh: string | null; onRetry: () => void }) {
  if (state === 'connected') return null;
  return <div className={`cf-network-banner ${state === 'disconnected' ? 'disconnected' : ''}`} role={state === 'disconnected' ? 'alert' : 'status'}>{state === 'disconnected' ? <WifiOff size={19} /> : <RefreshCw size={19} className="cf-spin" />}<div><strong>{state === 'disconnected' ? 'Connection unavailable. Presence may be out of date.' : 'Refreshing the roster...'}</strong><span>{lastRefresh ? `Last refreshed ${new Date(lastRefresh).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. ` : 'No current roster has been loaded. '}{state === 'disconnected' ? "Verify physical presence and follow your center's outage procedure. This kiosk does not record offline." : 'Wait for a confirmed response before recording attendance.'}</span></div>{state === 'disconnected' && <button className="btn btn-secondary btn-sm" onClick={onRetry}><RefreshCw size={14} />Try again</button>}</div>;
}
