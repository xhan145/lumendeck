import { describe, expect, it } from 'vitest';
import { FILE_ZOOM, fileZoomActionFromKey, nextFileZoomDistance } from '../src/core/shell/fileZoom';

describe('Files Constellation zoom ergonomics', () => {
  it('brings the camera closer with each zoom-in button press', () => {
    const first = nextFileZoomDistance(FILE_ZOOM.initialDistance, FILE_ZOOM.buttonFactor);
    const second = nextFileZoomDistance(first, FILE_ZOOM.buttonFactor);
    expect(first).toBeLessThan(FILE_ZOOM.initialDistance);
    expect(second).toBeLessThan(first);
    expect(FILE_ZOOM.wheelSpeed).toBeGreaterThan(1);
  });

  it('clamps zoom to safe near/far camera distances', () => {
    expect(nextFileZoomDistance(1.4, 0.01)).toBe(FILE_ZOOM.minDistance);
    expect(nextFileZoomDistance(70, 50)).toBe(FILE_ZOOM.maxDistance);
    expect(nextFileZoomDistance(Infinity, 0.5)).toBe(FILE_ZOOM.initialDistance * 0.5);
    expect(nextFileZoomDistance(8, -3)).toBe(8);
    expect(FILE_ZOOM.minDistance).toBeGreaterThan(0.1);
  });

  it('recognizes keyboard and numpad zoom without intercepting other keys', () => {
    expect(fileZoomActionFromKey('+', 'Equal')).toBe('in');
    expect(fileZoomActionFromKey('=', 'Equal')).toBe('in');
    expect(fileZoomActionFromKey('Add', 'NumpadAdd')).toBe('in');
    expect(fileZoomActionFromKey('-', 'Minus')).toBe('out');
    expect(fileZoomActionFromKey('Subtract', 'NumpadSubtract')).toBe('out');
    expect(fileZoomActionFromKey('f', 'KeyF')).toBe('focus');
    expect(fileZoomActionFromKey('F', 'KeyF')).toBe('focus');
    expect(fileZoomActionFromKey('0', 'Digit0')).toBe('reset');
    expect(fileZoomActionFromKey('Enter', 'Enter')).toBeNull();
    expect(fileZoomActionFromKey('Tab', 'Tab')).toBeNull();
  });
});
