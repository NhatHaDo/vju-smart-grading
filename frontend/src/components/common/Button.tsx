import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
type Size    = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

// 2026-07-29: 'secondary' used to be a very low-contrast flat gray
// (background #F3F4F6, border #E5E7EB) that made whole toolbars of buttons
// blur together ("mấy cái nút này không màu khó nhìn quá"). Bumped to a
// white background with a darker, thicker border so each button reads as
// its own control. Added 'outline' — same red as 'primary' but on a white
// background — for actions that should stand out from the plain secondary
// row without introducing a second accent color (user explicitly asked for
// under 2 colors total across a toolbar).
const VARIANT_STYLES: Record<Variant, { background: string; color: string; border: string }> = {
  primary:   { background: '#C8102E', color: '#fff',    border: '1.5px solid #C8102E' },
  secondary: { background: '#fff',    color: '#374151', border: '1.5px solid #C7CBD1' },
  outline:   { background: '#fff',    color: '#C8102E', border: '1.5px solid #C8102E' },
  danger:    { background: '#CF2E2E', color: '#fff',    border: '1.5px solid #CF2E2E' },
  ghost:     { background: 'none',    color: '#6B7280', border: '1px solid transparent' },
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
          whiteSpace: 'nowrap',
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.55 : 1,
          transition: 'transform 150ms, box-shadow 150ms, opacity 150ms',
          ...vs,
          ...ss,
          ...style,
        }}
        onMouseEnter={e => {
          if (isDisabled) return;
          const el = e.currentTarget as HTMLButtonElement;
          if (variant === 'primary' || variant === 'danger') {
            el.style.transform = 'translateY(-1px)';
            el.style.boxShadow = `0 6px 18px ${variant === 'primary' ? 'rgba(200,16,46,0.35)' : 'rgba(207,46,46,0.35)'}`;
          } else if (variant === 'outline') {
            el.style.background = '#FEF2F2';
          } else if (variant === 'secondary') {
            el.style.background = '#F9FAFB';
          }
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLButtonElement;
          el.style.transform = '';
          el.style.boxShadow = '';
          if (variant === 'outline' || variant === 'secondary') el.style.background = vs.background;
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
