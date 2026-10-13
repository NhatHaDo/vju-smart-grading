import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/** A page opened from a kỳ thi's page (ExamHubPage passes { hub: {id, name} })
 *  gets a bar back to it — the iPhone app has no browser Back button. */
export default function HubBackBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const hub = (location.state as { hub?: { id: number; name: string } } | null)?.hub;
  if (!hub || location.pathname === `/app/exams/${hub.id}`) return null;
  return (
    <button type="button" className="hub-back-bar" onClick={() => navigate(`/app/exams/${hub.id}`)}>
      <ArrowLeft size={16} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hub.name || 'Kỳ thi'}</span>
    </button>
  );
}
