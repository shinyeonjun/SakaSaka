import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren, ReactNode } from "react";
import type { RuntimeStatus } from "../types";
import { runtimeDescription } from "../format";
import { statusTone } from "../runtime";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "neutral" | "subtle" | "danger";
type ButtonSize = "small" | "medium" | "large";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "neutral", size = "medium", className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn("button", `button-${variant}`, `button-${size}`, className)} {...props} />;
}

export function Card({ className, children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return <section className={cn("card", className)} {...props}>{children}</section>;
}

export function Pill({ tone = "neutral", children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLSpanElement>> & { tone?: string }) {
  return <span className={cn("pill", `pill-${tone}`, className)} {...props}>{children}</span>;
}

export function StatusBadge({ status, className }: { status: RuntimeStatus; className?: string }) {
  return <Pill tone={statusTone(status)} className={cn("status-badge", className)} title={runtimeDescription(status)}>{status}</Pill>;
}

export function PageHeading({ title, description, status, actions }: { title: string; description?: string; status?: RuntimeStatus; actions?: ReactNode }) {
  return (
    <header className="page-heading">
      <div className="page-heading-copy">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {(status || actions) && <div className="page-heading-actions">{status && <StatusBadge status={status} />}{actions}</div>}
    </header>
  );
}

export function Label({ children, htmlFor }: PropsWithChildren<{ htmlFor?: string }>) {
  return <label className="field-label" htmlFor={htmlFor}>{children}</label>;
}

export function ProgressBar({ value, tone = "mint" }: { value: number; tone?: string }) {
  return <div className="progress-track" aria-label={`${Math.round(value * 100)}%`}><span className={`progress-fill fill-${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>;
}

export function Stat({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail?: string; tone?: string }) {
  return <div className={cn("stat", `stat-${tone}`)}><span className="stat-label">{label}</span><strong>{value}</strong>{detail && <span className="stat-detail">{detail}</span>}</div>;
}

export function Divider() {
  return <div className="divider" aria-hidden="true" />;
}

export function InlineNotice({ tone = "blue", title, children }: PropsWithChildren<{ tone?: string; title?: string }>) {
  return <div className={cn("inline-notice", `notice-${tone}`)}>{title && <strong>{title}</strong>}<span>{children}</span></div>;
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return <div className="section-header"><h2>{title}</h2>{action}</div>;
}

export function IconText({ symbol, children }: PropsWithChildren<{ symbol: string }>) {
  return <span className="icon-text"><span aria-hidden="true">{symbol}</span>{children}</span>;
}
