import { useMemo } from 'react';
import { decodeInspectionVisual } from '../visual/inspection-payload';
import { ArtworkCanvas } from './artwork-canvas';

function inspectionPayload(): string {
  return window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
}

export function InspectionApp() {
  const visual = useMemo(() => {
    try {
      return decodeInspectionVisual(inspectionPayload());
    } catch {
      return null;
    }
  }, []);

  if (!visual) {
    return <main className="inspection-surface" data-inspection-error="true" />;
  }

  return (
    <main className="inspection-surface">
      <ArtworkCanvas mode="inspection" visual={visual} />
    </main>
  );
}
