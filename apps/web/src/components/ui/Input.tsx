import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

/** Text input with label + error slot. forwardRef so react-hook-form can register it. */
export const Input = forwardRef<HTMLInputElement, InputProps>(({ label, error, hint, id, className, ...rest }, ref) => {
  const inputId = id ?? rest.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
          {label}
          {rest.required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={!!error}
        className={cn(
          'block h-9 w-full rounded-md border bg-white px-3 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-50',
          error ? 'border-red-400 focus:ring-red-500' : 'border-slate-300',
          className,
        )}
        {...rest}
      />
      {error ? <p className="text-xs text-red-600">{error}</p> : hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
});
Input.displayName = 'Input';
