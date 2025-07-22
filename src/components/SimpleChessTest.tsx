'use client';

import { useState, useEffect } from 'react';

export default function SimpleChessTest() {
  const [Chessboard, setChessboard] = useState<any>(null);
  const [fen, setFen] = useState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

  useEffect(() => {
    import('react-chessboard').then((mod) => {
      console.log('Loaded react-chessboard:', mod);
      setChessboard(() => mod.Chessboard);
    });
  }, []);

  function onDrop(sourceSquare: string, targetSquare: string) {
    console.log('Simple test - onDrop called:', sourceSquare, targetSquare);
    // For testing, just return true
    return true;
  }

  if (!Chessboard) {
    return <div>Loading chess board...</div>;
  }

  return (
    <div className="bg-white p-4 rounded">
      <h2 className="text-black mb-4">Simple Chess Test</h2>
      <div style={{ width: 400 }}>
        <Chessboard 
          position={fen}
          onPieceDrop={onDrop}
          arePiecesDraggable={true}
        />
      </div>
      <button 
        onClick={() => console.log('Test button clicked')}
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
      >
        Test Button
      </button>
    </div>
  );
}