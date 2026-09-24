import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, Inbox, type LucideIcon } from 'lucide-react';
const initials = (name: string) => name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();

export function Avatar({name,size='md'}:{name:string;size?:'sm'|'md'|'lg'}) {
  const color = [...name].reduce((n,c)=>n+c.charCodeAt(0),0)%6;
  return <span className={`avatar avatar-${size} avatar-${color}`} aria-hidden="true">{initials(name)}</span>;
}
export function Badge({children,tone='gray'}:{children:ReactNode;tone?:'blue'|'green'|'amber'|'red'|'gray'|'purple'}) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function EmptyState({icon:Icon=Inbox,title,description,action}:{icon?:LucideIcon;title:string;description:string;action?:ReactNode}) { return <div className="empty-state"><span className="empty-icon"><Icon size={24}/></span><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function Modal({title,subtitle,children,onClose,wide=false,initialFocus='field'}:{title:string;subtitle?:string;children:ReactNode;onClose:()=>void;wide?:boolean;initialFocus?:'field'|'close'}) {
  const ref=useRef<HTMLDivElement>(null); const id=useId(); const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null; const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const first=(initialFocus==='field'?ref.current?.querySelector<HTMLElement>('input:not([type="checkbox"]),select,textarea'):null)||ref.current?.querySelector<HTMLElement>('button');first?.focus();
    const listener=(e:KeyboardEvent)=>{if(e.key==='Escape')closeRef.current();if(e.key==='Tab'){
      const nodes=[...ref.current!.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')];
      const a=nodes[0],b=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();b?.focus();}else if(!e.shiftKey&&document.activeElement===b){e.preventDefault();a?.focus();}
    }}; document.addEventListener('keydown',listener);
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',listener);previous?.focus();};
  },[]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={ref} className={`modal ${wide?'modal-wide':''}`} role="dialog" aria-modal="true" aria-labelledby={id}><div className="modal-header"><div><h2 id={id}>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div><div className="modal-body">{children}</div></div></div>;
}
