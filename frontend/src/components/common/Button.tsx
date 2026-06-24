import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size    = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

const VARIANT_STYLES: Record<Variant, { background: string; color: string; border: string }> = {
  primary:   { background: '#C8102E', color: '#fff',     border: 'none' },
  secondary: { background: '#F3F4F6', color: '#374151',  border: '1px solid #E5E7EB' },
  danger:    { background: '#CF2E2E', color: '#fff',     border: 'none' },
  ghost:     { background: 'none',   color: '#6B7280',   border: '1px solid transparent' },
};

const SIZE_STYLES: Record<Size, { padding: string; fontSize: number; height: number; borderRadius: number }> = {
  sm: { padding: "0 14px", fontSize: 12, height: 32, borderRadius: 9999 },
  md: { padding: "0 18px", fontSize: 14, height: 40, borderRadius: 9999 },
  lg: { padding: "0 24px", fontSize: 15, height: 48, borderRadius: 9999 },
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, icon, children, disabled, style, ...rest }, ref) => {
    const vs = VARIANT_STYLES[variant];
    const ss = SIZE_STYLES[size];
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
          fontFamily: 'inherit',
          fontWeight: 600,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.55 : 1,
          transition: 'transform 150ms, box-shadow 150ms, opacity 150ms',
          ...vs,
          ...ss,
          ...style,
        }}
        onMouseEnter={e => {
          if (!isDisabled && variant === 'primary') {
            (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
            (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 18px rgba(200,16,46,0.35)';
          }
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = '';
          (e.currentTarget as HTMLButtonElement).style.boxShadow = '';
        }}
        {...rest}
      >
        {loading ? <span style={{ fontSize: 12 }}>●●●</span> : icon}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';
export default Button;
