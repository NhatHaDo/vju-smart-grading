import { AuthProvider } from './providers';
import AppRoutes from './routes';

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
