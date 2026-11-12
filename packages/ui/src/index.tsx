"use client";
import type { ButtonHTMLAttributes, InputHTMLAttributes, HTMLAttributes } from 'react';
import { useId } from 'react';
export function Button({ type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button type={type} {...props} />; }
export function Field({ label, id, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const generated = useId(); const inputId = id ?? generated;
  return <label htmlFor={inputId}>{label}<input id={inputId} {...props} /></label>;
}
export function Badge(props: HTMLAttributes<HTMLSpanElement>) { return <span {...props} />; }
