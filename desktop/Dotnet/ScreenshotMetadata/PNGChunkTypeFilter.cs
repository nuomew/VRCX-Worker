using System;

namespace VRCX;

[Flags]
public enum PNGChunkTypeFilter
{
    UNKNOWN = 0,
    IHDR = 1 << 0,
    sRGB = 1 << 1,
    iTXt = 1 << 2,
    IDAT = 1 << 3,
    IEND = 1 << 4
}
