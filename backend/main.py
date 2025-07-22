from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os
from dotenv import load_dotenv
import litellm
from daisys import DaisysAPI
import asyncio
from typing import Optional
from pathlib import Path

load_dotenv()

app = FastAPI(title="Roasted Chessnuts Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Daisys credentials from environment
DAISYS_EMAIL = os.getenv("DAISYS_EMAIL")
DAISYS_PASSWORD = os.getenv("DAISYS_PASSWORD")
DAISYS_VOICE_ID = os.getenv("DAISYS_VOICE_ID")

# Initialize Daisys API client globally
daisys_client = None
if DAISYS_EMAIL and DAISYS_PASSWORD:
    try:
        # Create the client but don't enter context yet
        daisys_client = DaisysAPI('speak', email=DAISYS_EMAIL, password=DAISYS_PASSWORD)
        print("Daisys API client created successfully")
    except Exception as e:
        print(f"Failed to create Daisys API client: {str(e)}")
        daisys_client = None

class MoveRequest(BaseModel):
    fen: str
    move: str
    player: str  # "human" or "computer"
    moveHistory: list[str]

class CommentaryResponse(BaseModel):
    commentary: str
    audioUrl: Optional[str] = None

@app.post("/api/move", response_model=CommentaryResponse)
async def process_move(move_request: MoveRequest):
    try:
        prompt = f"""You are a chess commentator with a dark, sarcastic sense of humor. You're commenting on a chess game in real-time. 
        
Current position (FEN): {move_request.fen}
Last move: {move_request.move}
Player who made the move: {move_request.player}
Move history: {', '.join(move_request.moveHistory[-10:])}

Provide brief, witty commentary (1-2 sentences) on this move. Be funny but not mean-spirited. Roast bad moves, celebrate brilliant ones with backhanded compliments, and add personality. Keep it under 50 words.

Examples of style:
- "Oh, moving the knight there? Bold strategy, let's see if it pays off... spoiler alert: it won't."
- "That's actually a decent move. I'm as shocked as you are."
- "Ah yes, the classic 'I have no idea what I'm doing' gambit. Timeless."
"""

        response = await litellm.acompletion(
            model=os.getenv("LLM_MODEL", "gpt-3.5-turbo"),
            messages=[{"role": "user", "content": prompt}],
            max_tokens=100,
            temperature=0.8
        )
        
        commentary = response.choices[0].message.content
        
        # Generate TTS with Daisys
        audio_url = None
        if daisys_client and DAISYS_VOICE_ID:
            try:
                with daisys_client as speak:
                    # Generate take without waiting
                    take = speak.generate_take(
                        voice_id=DAISYS_VOICE_ID,
                        text=commentary,
                        wait=True
                    )
                    print(f"Generated TTS take: {take.take_id}")
                    #await asyncio.sleep(1)
                    
                    # Get the audio URL
                    audio_url = speak.get_take_audio_url(take.take_id)
                    print(f"Audio URL: {audio_url}")
            except Exception as e:
                print(f"Error generating TTS: {str(e)}")
                import traceback
                traceback.print_exc()
                # Continue without audio if TTS fails
        
        return CommentaryResponse(
            commentary=commentary,
            audioUrl=audio_url
        )
        
    except Exception as e:
        print(f"Error processing move: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "Roasted Chessnuts"}

# Serve Next.js static files
static_dir = Path("/app/static")
if static_dir.exists():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
else:
    # Fallback route for development
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        return {"message": "Frontend not built. Run npm run build and export."}

# Shutdown event removed - using context manager per request instead

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
