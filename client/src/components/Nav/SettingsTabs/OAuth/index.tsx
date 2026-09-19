import Clients from './Clients';
import Grants from './Grants';

export default function OAuthApps() {
  return (
    <div className="flex flex-col gap-8">
      <Clients />
      <Grants />
    </div>
  );
}
