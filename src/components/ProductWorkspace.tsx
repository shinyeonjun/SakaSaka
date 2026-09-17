import type { PropsWithChildren, ReactNode } from "react";

export function ProductWorkspace({ children, inspector }: PropsWithChildren<{ inspector?: ReactNode }>) {
  return <div className={`product-workspace ${inspector ? "product-workspace-with-inspector" : ""}`}>
    <section className="product-main-pane">{children}</section>
    {inspector && <aside className="product-inspector">{inspector}</aside>}
  </div>;
}

export function ProductHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="product-header">
    <div className="product-header-copy"><span className="product-eyebrow">{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="product-header-actions">{actions}</div>}
  </div>;
}

export function Surface({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <section className={`product-surface ${className}`.trim()}>{children}</section>;
}

export function SurfaceHeader({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="product-surface-header"><h2>{title}</h2><div className="product-surface-meta">{meta && <span>{meta}</span>}{action}</div></div>;
}

export function InspectorHeader({ title, meta }: { title: string; meta?: string }) {
  return <div className="product-inspector-header"><strong>{title}</strong>{meta && <span>{meta}</span>}</div>;
}

export function InspectorCard({ title, meta, children }: PropsWithChildren<{ title: string; meta?: string }>) {
  return <section className="inspector-card"><div className="inspector-card-head"><strong>{title}</strong>{meta && <span>{meta}</span>}</div>{children}</section>;
}

export function StatusDot({ tone = "neutral" }: { tone?: "success" | "working" | "evidence" | "warning" | "danger" | "human" | "neutral" }) {
  return <span className={`product-dot product-dot-${tone}`} aria-hidden="true" />;
}

export function StatusPill({ children, tone = "neutral" }: PropsWithChildren<{ tone?: "success" | "working" | "evidence" | "warning" | "danger" | "human" | "primary" | "neutral" }>) {
  return <span className={`product-pill product-pill-${tone}`}>{children}</span>;
}

export function KeyValue({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return <div className="product-kv"><span>{label}</span><strong className={tone ? `text-${tone}` : undefined}>{value}</strong></div>;
}

export function EmptyPanel({ children }: PropsWithChildren) {
  return <div className="product-empty">{children}</div>;
}
