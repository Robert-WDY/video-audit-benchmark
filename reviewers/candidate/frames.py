"""Native display timestamps and localized change proposals for short benchmark shots."""
import json
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageOps


def decode(video):
    def run(args):
        return subprocess.run(args, check=True, capture_output=True, timeout=180).stdout
    data = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "frame=best_effort_timestamp_time:stream=width,height", "-of", "json", str(video)]))
    times = np.array([float(x["best_effort_timestamp_time"]) for x in data["frames"]])
    if not len(times) or np.any(np.diff(times) < 0):
        raise ValueError("Invalid display timestamps")
    size = data["streams"][0]
    scale = min(1, 480/max(size["width"],size["height"]))
    w,h = [max(2,round(size[k]*scale/2)*2) for k in ("width","height")]
    raw = run(["ffmpeg","-v","error","-threads","1","-noautorotate","-i",str(video),"-map","0:v:0",
        "-vf",f"scale={w}:{h}","-fps_mode","passthrough","-pix_fmt","rgb24","-threads","1","-f","rawvideo","-"])
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1,h,w,3)
    if len(times) != len(frames):
        raise ValueError("Frame/timestamp count mismatch")
    return times-times[0], frames


def proposals(times, frames):
    if len(times)<2:
        return []
    small = np.stack([np.asarray(Image.fromarray(f).resize((96,64),Image.Resampling.BOX)) for f in frames])
    diff = np.abs(np.diff(small.astype(np.int16),axis=0)).reshape(-1,4,16,6,16,3).mean(axis=(2,4,5))
    strength = diff / np.maximum(12,4*np.median(diff,axis=0))
    out = []
    for idx in np.argsort(-strength.max(axis=(1,2)),kind="stable"):
        y,x = np.unravel_index(np.argmax(strength[idx]),(4,6))
        if strength[idx,y,x]<1:
            break
        j = int(idx)+1
        if all(abs(times[j]-times[other["frame"]])>=0.30 for other in out):
            out.append(dict(frame=j,cell=[int(x),int(y)],ratio=round(float(strength[idx,y,x]),3)))
            if len(out)==4:
                break
    return out


def board(times,frames,slots,path):
    cells = list(dict.fromkeys((int(i),tuple(cell) if cell is not None else None) for i,cell in slots))
    cols=min(len(cells),4)
    canvas=Image.new("RGB",(cols*300,((len(cells)+cols-1)//cols)*232),"#161616")
    draw=ImageDraw.Draw(canvas)
    for j,(i,cell) in enumerate(cells):
        x,y=j%cols*300,j//cols*232
        im=Image.fromarray(frames[i])
        draw.text((x+2,y+3),f"frame {i} | {times[i]:.3f}s",fill="white")
        if cell is None:
            thumb=ImageOps.contain(im,(296,208))
            canvas.paste(thumb,(x+(300-thumb.width)//2,y+20))
        else:
            w,h=im.size
            a,b=cell
            roi=(int(max(0,a-.5)*w/6),int(max(0,b-.5)*h/4),int(min(6,a+1.5)*w/6),int(min(4,b+1.5)*h/4))
            for offset,img in [(0,im),(150,im.crop(roi))]:
                thumb=ImageOps.contain(img,(148,208))
                canvas.paste(thumb,(x+offset,y+20))
    canvas.save(path,quality=89)
    return sorted({i for i,_ in cells})
